// -*- coding: utf-8 -*-
//
// Rust port of the given Python "dumb saver" clipboard daemon.
// - 极简模式：只负责读取系统剪贴板并保存到指定目录（dumb saver）
// - 移除所有指纹计算、去重逻辑
// - 移除 HTML 解析逻辑（由 Node.js 侧处理）
// - 仅处理：纯文本、文件复制、原生图片保存
//
// 目标：按你贴出的 Python 版本“行为等同”：
// - daemon 协议：stdin JSON line -> stdout JSON line
// - JSON dumps：默认 separators (", ", ": ")；ensure_ascii 默认 True；exit 时 ensure_ascii=False
// - actions: ping / extract_icon / clipboard_peek(peek) / get_clipboard_files / get_html / exit / clipboard(paste) / folder_info(get_folder_info)
//
// 说明：本文件为 *Linux/macOS* 版本（Windows 请继续用你之前那份）。

#![cfg(not(windows))]

use base64::{engine::general_purpose, Engine as _};
use chrono::{Datelike, Local};
use filetime::{set_file_times, FileTime};
use once_cell::sync::Lazy;
use rand::seq::SliceRandom;
use rand::thread_rng;
use regex::Regex;
use serde::ser::{SerializeMap, SerializeSeq};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{self, BufRead, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use threadpool::ThreadPool;
use url::Url;
use walkdir::WalkDir;

// =============================================================================
//  配置
// =============================================================================

fn compute_max_workers() -> usize {
    // Python: min(32, max(4, (os.cpu_count() or 4) * 2))
    let c = num_cpus::get();
    let cpu = if c == 0 { 4 } else { c };
    let v = (cpu * 2).max(4);
    v.min(32)
}

static MAX_WORKERS: Lazy<usize> = Lazy::new(compute_max_workers);
static IO_POOL: Lazy<ThreadPool> = Lazy::new(|| ThreadPool::new(*MAX_WORKERS));

static RE_INVALID_FILENAME: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[<>:\"/\\|?*]+"#).unwrap());

static VALID_CHARS: Lazy<Vec<char>> = Lazy::new(|| {
    // Python:
    // excluded_chars = ["l", "i", "s", "a", "m", "c", "b", "f", "t"]
    // valid_chars = [c for c in "abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" if c.lower() not in excluded_chars]
    let excluded = ["l", "i", "s", "a", "m", "c", "b", "f", "t"];
    let base = "abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    base.chars()
        .filter(|c| {
            let lc = c.to_ascii_lowercase().to_string();
            !excluded.contains(&lc.as_str())
        })
        .collect()
});

// =============================================================================
//  Python 风格 JSON 值：保证对象字段“插入顺序”
// =============================================================================

#[derive(Clone, Debug)]
enum PyV {
    Null,
    Bool(bool),
    Num(serde_json::Number),
    Str(String),
    Arr(Vec<PyV>),
    Obj(Vec<(String, PyV)>),
}

impl Serialize for PyV {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            PyV::Null => serializer.serialize_none(),
            PyV::Bool(b) => serializer.serialize_bool(*b),
            PyV::Num(n) => n.serialize(serializer),
            PyV::Str(s) => serializer.serialize_str(s),
            PyV::Arr(a) => {
                let mut seq = serializer.serialize_seq(Some(a.len()))?;
                for it in a {
                    seq.serialize_element(it)?;
                }
                seq.end()
            }
            PyV::Obj(o) => {
                let mut map = serializer.serialize_map(Some(o.len()))?;
                for (k, v) in o {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

fn pyv_from_json(v: &Value) -> PyV {
    match v {
        Value::Null => PyV::Null,
        Value::Bool(b) => PyV::Bool(*b),
        Value::Number(n) => PyV::Num(n.clone()),
        Value::String(s) => PyV::Str(s.clone()),
        Value::Array(a) => PyV::Arr(a.iter().map(pyv_from_json).collect()),
        Value::Object(o) => {
            let mut out = Vec::with_capacity(o.len());
            for (k, v) in o {
                out.push((k.clone(), pyv_from_json(v)));
            }
            PyV::Obj(out)
        }
    }
}

fn py_num_u64(x: u64) -> PyV {
    PyV::Num(serde_json::Number::from(x))
}

// =============================================================================
//  JSON dumps —— 模拟 Python json.dumps 默认 separators (", ", ": ")，并可控制 ensure_ascii
// =============================================================================

struct PyFormatter;

impl serde_json::ser::Formatter for PyFormatter {
    fn begin_array_value<W: ?Sized + io::Write>(&mut self, writer: &mut W, first: bool) -> io::Result<()> {
        if !first {
            writer.write_all(b", ")?;
        }
        Ok(())
    }
    fn begin_object_key<W: ?Sized + io::Write>(&mut self, writer: &mut W, first: bool) -> io::Result<()> {
        if !first {
            writer.write_all(b", ")?;
        }
        Ok(())
    }
    fn end_object_key<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        writer.write_all(b": ")?;
        Ok(())
    }
}

fn dumps_py(value: &PyV, ensure_ascii: bool) -> String {
    let mut buf: Vec<u8> = Vec::new();
    let formatter = PyFormatter;
    let mut ser = serde_json::ser::Serializer::with_formatter(&mut buf, formatter);
    // Serialize with appropriate options
    let _ = value.serialize(&mut ser);
    let mut result = String::from_utf8(buf).unwrap_or_else(|_| "{}".to_string());

    // Apply ASCII escaping if needed
    if ensure_ascii {
        // Simple ASCII escaping for non-ASCII characters
        result = result.chars().map(|c| {
            if c.is_ascii() {
                c.to_string()
            } else {
                format!("\\u{:04x}", c as u32)
            }
        }).collect();
    }

    result
}

// =============================================================================
//  工具：路径/文件名
// =============================================================================

fn resolve_output_dir(target_dir: Option<&str>) -> PathBuf {
    // Python: if target_dir: return Path(target_dir) else Path("./qqq")
    match target_dir {
        Some(s) if !s.is_empty() => PathBuf::from(s),
        _ => PathBuf::from("./qqq"),
    }
}

fn ensure_parent(path_obj: &Path) {
    if let Some(parent) = path_obj.parent() {
        let _ = fs::create_dir_all(parent);
    }
}

// Python Path.suffix / Path.stem 的关键语义：
// - ".bashrc" => suffix ""  stem ".bashrc"
// - "a."     => suffix "." stem "a"
// - "a.tar.gz" => suffix ".gz" stem "a.tar"
fn py_suffix(name: &str) -> String {
    if let Some(pos) = name.rfind('.') {
        if pos == 0 {
            return String::new();
        }
        return name[pos..].to_string();
    }
    String::new()
}

fn py_stem(name: &str) -> String {
    let suf = py_suffix(name);
    if suf.is_empty() {
        return name.to_string();
    }
    let cut = name.len().saturating_sub(suf.len());
    name[..cut].to_string()
}

fn get_timestamp_filename(ext: &str) -> String {
    let now = Local::now();
    let date_part = now.format("%Y.%m.%d").to_string();
    let weekday_number = now.weekday().number_from_monday(); // 1..=7
    let millisecond_part = format!("{:03}", (now.timestamp_subsec_micros() / 1000) as u32);

    let mut rng = thread_rng();
    let valid = &*VALID_CHARS;

    let first_char = *valid.choose(&mut rng).unwrap_or(&'X');
    let second_char = if first_char.to_ascii_lowercase() == 'g' {
        let without_g: Vec<char> = valid.iter().copied().filter(|c| c.to_ascii_lowercase() != 'g').collect();
        *without_g.choose(&mut rng).unwrap_or(&'X')
    } else {
        *valid.choose(&mut rng).unwrap_or(&'X')
    };

    let random_chars = format!("{}{}", first_char, second_char);
    let prefix_code = format!("{}{}", millisecond_part, random_chars);
    let time_part = now.format("%H.%M.%S").to_string();

    format!("{}_{}__[{}]__{}{}", prefix_code, date_part, weekday_number, time_part, ext)
}

fn safe_filename(name: &str) -> String {
    // Python:
    // if not name: return get_timestamp_filename(".bin")
    // n = str(name).strip().replace("\x00", "")
    // n = re.sub(r'[<>:"/\\|?*]+', "_", n)
    // n = n.strip(" .\t\r\n")
    // if not n: return get_timestamp_filename(".bin")
    // if len(n) > 180:
    //     stem = Path(n).stem[:160]
    //     ext = Path(n).suffix
    //     n = stem + ext
    // return n

    if name.is_empty() {
        return get_timestamp_filename(".bin");
    }

    let mut n = name.trim().replace('\u{0000}', "");
    n = RE_INVALID_FILENAME.replace_all(&n, "_").to_string();

    n = n
        .trim_matches(|c: char| c == ' ' || c == '.' || c == '\t' || c == '\r' || c == '\n')
        .to_string();

    if n.is_empty() {
        return get_timestamp_filename(".bin");
    }

    if n.chars().count() > 180 {
        let stem = py_stem(&n);
        let suf = py_suffix(&n);
        let stem_trunc: String = stem.chars().take(160).collect();
        n = format!("{}{}", stem_trunc, suf);
    }

    n
}

fn unique_path_in_dir(output_dir: &Path, name: &str) -> PathBuf {
    let base = output_dir.join(name);
    if !base.exists() {
        return base;
    }

    let stem = py_stem(name);
    let ext = py_suffix(name);

    for i in 1..1000 {
        let new_name = format!("{}_{}{}", stem, i, ext);
        let p = output_dir.join(new_name);
        if !p.exists() {
            return p;
        }
    }
    base
}

// =============================================================================
//  PNG 编码（图标/图片统一用 PNG 输出）
// =============================================================================

fn png_bytes_from_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ColorType;
    use image::ImageEncoder;

    let mut out: Vec<u8> = Vec::new();
    {
        let encoder = PngEncoder::new_with_quality(&mut out, CompressionType::Default, FilterType::Adaptive);
        encoder
            .write_image(rgba, width, height, ColorType::Rgba8.into())
            .map_err(|e| e.to_string())?;
    }
    Ok(out)
}

// =============================================================================
//  文件复制 (Dumb Copy) —— 尽量模拟 shutil.copy2
// =============================================================================

fn copy2_like(src: &Path, dst: &Path) -> Result<(), String> {
    ensure_parent(dst);

    fs::copy(src, dst).map_err(|e| e.to_string())?;

    if let Ok(meta) = fs::metadata(src) {
        let _ = fs::set_permissions(dst, meta.permissions());

        let atime = FileTime::from_last_access_time(&meta);
        let mtime = FileTime::from_last_modification_time(&meta);
        let _ = set_file_times(dst, atime, mtime);
    }

    Ok(())
}

fn copy_files_parallel(src_files: Vec<PathBuf>, output_dir: &Path) -> Vec<String> {
    if src_files.is_empty() {
        return vec![];
    }

    let _ = fs::create_dir_all(output_dir);

    let (tx, rx) = mpsc::channel::<Option<String>>();
    let inflight = std::cmp::max(64usize, *MAX_WORKERS * 16);
    let mut pending = 0usize;

    let mut results: Vec<String> = Vec::new();

    for src in src_files {
        let txc = tx.clone();
        let out_dir = output_dir.to_path_buf();

        IO_POOL.execute(move || {
            let result = (|| -> Option<String> {
                let fname = src.file_name()?.to_string_lossy().to_string();
                let fname = safe_filename(&fname);
                let dst = unique_path_in_dir(&out_dir, &fname);

                if copy2_like(&src, &dst).is_ok() {
                    Some(dst.to_string_lossy().to_string())
                } else {
                    None
                }
            })();

            let _ = txc.send(result);
        });

        pending += 1;
        while pending > inflight {
            if let Ok(opt) = rx.recv() {
                pending = pending.saturating_sub(1);
                if let Some(p) = opt {
                    results.push(p);
                }
            } else {
                pending = pending.saturating_sub(1);
            }
        }
    }

    drop(tx);

    for opt in rx {
        if let Some(p) = opt {
            results.push(p);
        }
    }

    results
}

fn copytree_parallel(src_dir: &Path, output_dir: &Path) -> Option<String> {
    if !src_dir.exists() || !src_dir.is_dir() {
        return None;
    }

    let _ = fs::create_dir_all(output_dir);

    let dir_name = src_dir.file_name()?.to_string_lossy().to_string();
    let dst_name = safe_filename(&dir_name);

    let mut dst_dir = output_dir.join(&dst_name);
    if dst_dir.exists() {
        dst_dir = unique_path_in_dir(output_dir, &dst_name);
    }

    if fs::create_dir_all(&dst_dir).is_err() {
        return None;
    }

    let walk_root = src_dir.to_path_buf();

    let (tx, rx) = mpsc::channel::<()>();
    let inflight = std::cmp::max(128usize, *MAX_WORKERS * 32);
    let mut pending = 0usize;

    for entry in WalkDir::new(&walk_root).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let sp = entry.path().to_path_buf();
        let rel = match sp.strip_prefix(&walk_root) {
            Ok(r) => r.to_path_buf(),
            Err(_) => continue,
        };
        let dp = dst_dir.join(rel);

        if entry.file_type().is_dir() {
            let _ = fs::create_dir_all(&dp);
            continue;
        }

        if let Some(parent) = dp.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let txc = tx.clone();
        IO_POOL.execute(move || {
            let _ = copy2_like(&sp, &dp);
            let _ = txc.send(());
        });

        pending += 1;
        while pending > inflight {
            if rx.recv().is_ok() {
                pending = pending.saturating_sub(1);
            } else {
                pending = pending.saturating_sub(1);
            }
        }
    }

    drop(tx);
    for _ in rx {
        // drain
    }

    Some(dst_dir.to_string_lossy().to_string())
}

// =============================================================================
//  文件夹统计
// =============================================================================

fn python_like_ext_lower(path: &Path) -> String {
    let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let suf = py_suffix(&name);
    let mut ext = suf.to_ascii_lowercase().replace('.', "");
    if ext.is_empty() {
        ext = "no_ext".to_string();
    }
    ext
}

fn get_folder_info(folder_path: &str) -> PyV {
    if folder_path.is_empty() {
        return PyV::Obj(vec![
            ("success".to_string(), PyV::Bool(false)),
            ("error".to_string(), PyV::Str("empty path".to_string())),
        ]);
    }

    let p = PathBuf::from(folder_path);
    if !p.exists() || !p.is_dir() {
        return PyV::Obj(vec![
            ("success".to_string(), PyV::Bool(false)),
            ("error".to_string(), PyV::Str("path not a directory".to_string())),
        ]);
    }

    let mut total_size: u64 = 0;
    let mut file_count: u64 = 0;

    let mut ext_keys: Vec<String> = Vec::new();
    let mut ext_counts: std::collections::HashMap<String, u64> = std::collections::HashMap::new();

    for entry in WalkDir::new(&p).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.file_type().is_dir() {
            continue;
        }
        let sp = entry.path();
        let meta = match fs::metadata(sp) {
            Ok(m) => m,
            Err(_) => continue,
        };
        total_size = total_size.saturating_add(meta.len());
        file_count = file_count.saturating_add(1);

        let ext = python_like_ext_lower(sp);
        if !ext_counts.contains_key(&ext) {
            ext_keys.push(ext.clone());
        }
        *ext_counts.entry(ext).or_insert(0) += 1;
    }

    let mut ext_stats_pairs: Vec<(String, PyV)> = Vec::with_capacity(ext_keys.len());
    for k in ext_keys {
        let v = ext_counts.get(&k).copied().unwrap_or(0);
        ext_stats_pairs.push((k, py_num_u64(v)));
    }

    PyV::Obj(vec![
        ("success".to_string(), PyV::Bool(true)),
        ("total_size".to_string(), py_num_u64(total_size)),
        ("file_count_root".to_string(), py_num_u64(file_count)),
        ("ext_stats".to_string(), PyV::Obj(ext_stats_pairs)),
    ])
}

// =============================================================================
//  Daemon / CLI 工具
// =============================================================================

fn decode_utf8_ignore(mut bytes: &[u8]) -> String {
    // Python: decode('utf-8', errors='ignore')
    let mut out = String::new();
    while !bytes.is_empty() {
        match std::str::from_utf8(bytes) {
            Ok(s) => {
                out.push_str(s);
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                if valid > 0 {
                    unsafe {
                        out.push_str(std::str::from_utf8_unchecked(&bytes[..valid]));
                    }
                }
                let skip = e.error_len().unwrap_or(1);
                let next = valid.saturating_add(skip);
                if next >= bytes.len() {
                    break;
                }
                bytes = &bytes[next..];
            }
        }
    }
    out
}

fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i != 0
            } else if let Some(u) = n.as_u64() {
                u != 0
            } else if let Some(f) = n.as_f64() {
                f != 0.0
            } else {
                false
            }
        }
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn py_str_like(v: Option<&Value>) -> String {
    match v {
        None => "None".to_string(),
        Some(Value::Null) => "None".to_string(),
        Some(Value::Bool(true)) => "True".to_string(),
        Some(Value::Bool(false)) => "False".to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => {
            let mut parts: Vec<String> = Vec::new();
            for it in a {
                parts.push(py_str_like(Some(it)));
            }
            format!("[{}]", parts.join(", "))
        }
        Some(Value::Object(o)) => {
            let mut parts: Vec<String> = Vec::new();
            for (k, v) in o {
                let key = format!("'{}'", k.replace('\'', "\\'"));
                let val = match v {
                    Value::String(s) => format!("'{}'", s.replace('\'', "\\'")),
                    _ => py_str_like(Some(v)),
                };
                parts.push(format!("{}: {}", key, val));
            }
            format!("{{{}}}", parts.join(", "))
        }
    }
}

fn pick_request_id(cmd: &serde_json::Map<String, Value>) -> PyV {
    // Python: request_id = cmd.get("_id", cmd.get("id", 0))
    if let Some(v) = cmd.get("_id") {
        pyv_from_json(v)
    } else if let Some(v) = cmd.get("id") {
        pyv_from_json(v)
    } else {
        py_num_u64(0)
    }
}

// =============================================================================
//  平台：Linux/macOS（Windows 用你之前的文件）
// =============================================================================

mod platform {
    use super::*;
    use clipboard_rs::{Clipboard, ClipboardContext};
    use clipboard_rs::common::RustImage;

    #[cfg(target_os = "linux")]
    use clipboard_rs::ClipboardContextX11Options;

    #[cfg(feature = "icons")]
    use file_icon_provider::get_file_icon;

    const WL_PASTE_TIMEOUT: Duration = Duration::from_millis(2000);

    fn setup_clipboard() -> Result<ClipboardContext, String> {
        #[cfg(target_os = "linux")]
        {
            // X11 读取大图像时 500ms 默认超时会误伤；这里设一个“足够大但不至于永久挂死”的上限。
            // 如需更激进可调大；但不要 None（避免无限阻塞）。
            let opts = ClipboardContextX11Options {
                read_timeout: Some(Duration::from_secs(10)),
            };
            ClipboardContext::new_with_options(opts).map_err(|e| e.to_string())
        }

        #[cfg(not(target_os = "linux"))]
        {
            ClipboardContext::new().map_err(|e| e.to_string())
        }
    }

    // ----------------------------
    // Wayland wl-paste 增强（仅 Linux）
    // ----------------------------

    #[cfg(target_os = "linux")]
    fn is_wayland_session() -> bool {
        std::env::var("WAYLAND_DISPLAY").map(|s| !s.is_empty()).unwrap_or(false)
    }

    #[cfg(target_os = "linux")]
    fn has_wl_paste() -> bool {
        // 不引入额外依赖：直接尝试执行。
        match std::process::Command::new("wl-paste").arg("--version").output() {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    }

    #[cfg(target_os = "linux")]
    fn run_cmd_capture(mut cmd: std::process::Command, timeout: Duration) -> Option<Vec<u8>> {
        let mut child = cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().ok()?;
        let start = Instant::now();

        loop {
            if let Ok(Some(_status)) = child.try_wait() {
                break;
            }
            if start.elapsed() >= timeout {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            thread::sleep(Duration::from_millis(10));
        }

        let mut out = Vec::new();
        if let Some(mut stdout) = child.stdout.take() {
            let _ = stdout.read_to_end(&mut out);
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    #[cfg(target_os = "linux")]
    fn wl_paste_bytes(mime: Option<&str>) -> Option<Vec<u8>> {
        let mut c = std::process::Command::new("wl-paste");
        c.arg("--no-newline");
        if let Some(t) = mime {
            c.arg("--type").arg(t);
        }
        run_cmd_capture(c, WL_PASTE_TIMEOUT)
    }

    #[cfg(target_os = "linux")]
    fn wl_paste_list_types() -> Option<Vec<String>> {
        let mut c = std::process::Command::new("wl-paste");
        c.arg("--list-types");
        let out = run_cmd_capture(c, WL_PASTE_TIMEOUT)?;
        let s = decode_utf8_ignore(&out);
        let mut v = Vec::new();
        for line in s.lines() {
            let t = line.trim();
            if !t.is_empty() {
                v.push(t.to_string());
            }
        }
        if v.is_empty() { None } else { Some(v) }
    }

    #[cfg(target_os = "linux")]
    fn parse_uri_list_to_paths(bytes: &[u8]) -> Vec<PathBuf> {
        // text/uri-list: RFC 2483-ish, newline separated; lines starting with # are comments.
        let s = decode_utf8_ignore(bytes);
        let mut out = Vec::new();
        for line in s.lines() {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                continue;
            }
            // file:///... 或普通路径
            if let Ok(url) = Url::parse(t) {
                if url.scheme() == "file" {
                    if let Ok(p) = url.to_file_path() {
                        out.push(p);
                    }
                }
            } else {
                out.push(PathBuf::from(t));
            }
        }
        out
    }

    // ----------------------------
    // 统一读取：files / image / text / html
    // ----------------------------

    fn normalize_file_entry(s: &str) -> Option<PathBuf> {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        if let Ok(url) = Url::parse(t) {
            if url.scheme() == "file" {
                return url.to_file_path().ok();
            }
        }
        Some(PathBuf::from(t))
    }

    fn read_files_from_clipboard() -> Vec<PathBuf> {
        #[cfg(target_os = "linux")]
        {
            // Wayland 优先：wl-paste -t text/uri-list
            if is_wayland_session() && has_wl_paste() {
                if let Some(bytes) = wl_paste_bytes(Some("text/uri-list")) {
                    let v = parse_uri_list_to_paths(&bytes);
                    if !v.is_empty() {
                        return v;
                    }
                }
            }
        }

        // 兜底：clipboard-rs
        if let Ok(ctx) = setup_clipboard() {
            if let Ok(list) = ctx.get_files() {
                let mut out = Vec::new();
                for s in list {
                    if let Some(p) = normalize_file_entry(&s) {
                        out.push(p);
                    }
                }
                if !out.is_empty() {
                    return out;
                }
            }

            // 再兜底：尝试从 text/uri-list 读取
            if let Ok(types) = ctx.available_formats() {
                let has_uri = types.iter().any(|t| t.to_ascii_lowercase().contains("uri-list"));
                if has_uri {
                    // 常见：text/uri-list
                    if let Ok(buf) = ctx.get_buffer("text/uri-list") {
                        let mut out = Vec::new();
                        for p in buf.split(|&b| b == b'\n' || b == b'\r') {
                            let s = decode_utf8_ignore(p).trim().to_string();
                            if s.is_empty() || s.starts_with('#') {
                                continue;
                            }
                            if let Some(p) = normalize_file_entry(&s) {
                                out.push(p);
                            }
                        }
                        if !out.is_empty() {
                            return out;
                        }
                    }
                }
            }
        }

        Vec::new()
    }

    fn read_text_from_clipboard() -> Option<String> {
        #[cfg(target_os = "linux")]
        {
            if is_wayland_session() && has_wl_paste() {
                if let Some(bytes) = wl_paste_bytes(None) {
                    let s = decode_utf8_ignore(&bytes);
                    let s = s.trim().to_string();
                    if !s.is_empty() {
                        return Some(s);
                    }
                }
            }
        }

        if let Ok(ctx) = setup_clipboard() {
            if let Ok(s) = ctx.get_text() {
                let t = s.trim().to_string();
                if !t.is_empty() {
                    return Some(s);
                }
            }
        }
        None
    }

    fn read_image_png_bytes_from_clipboard() -> Option<Vec<u8>> {
        #[cfg(target_os = "linux")]
        {
            // Wayland 优先（PNG 直接写出）
            if is_wayland_session() && has_wl_paste() {
                // wl-paste 支持泛型 image，但我们优先明确 image/png
                if let Some(bytes) = wl_paste_bytes(Some("image/png")) {
                    return Some(bytes);
                }
                // 再尝试 "image" 让它自动挑
                if let Some(bytes) = wl_paste_bytes(Some("image")) {
                    return Some(bytes);
                }
            }
        }

        // clipboard-rs: get_image() -> RustImageData; to_png() -> RustImageBuffer
        if let Ok(ctx) = setup_clipboard() {
            if let Ok(img) = ctx.get_image() {
                // Explicit type annotation to resolve compilation error
                let buf = img.to_png().ok()?;
                let b = buf.get_bytes().to_vec();
                if !b.is_empty() {
                    return Some(b);
                }
            }
        }

        None
    }

    pub fn get_clipboard_files_only() -> PyV {
        let mut paths: Vec<PyV> = Vec::new();
        for p in read_files_from_clipboard() {
            paths.push(PyV::Str(p.to_string_lossy().to_string()));
        }

        if !paths.is_empty() {
            PyV::Obj(vec![
                ("type".to_string(), PyV::Str("file_paths".to_string())),
                ("paths".to_string(), PyV::Arr(paths)),
            ])
        } else {
            PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))])
        }
    }

    pub fn get_clipboard_html() -> PyV {
        #[cfg(target_os = "linux")]
        {
            if is_wayland_session() && has_wl_paste() {
                if let Some(bytes) = wl_paste_bytes(Some("text/html")) {
                    if let Ok(s) = String::from_utf8(bytes.clone()) {
                        return PyV::Obj(vec![
                            ("type".to_string(), PyV::Str("html".to_string())),
                            ("value".to_string(), PyV::Str(s)),
                        ]);
                    }
                    let b64 = general_purpose::STANDARD.encode(bytes);
                    return PyV::Obj(vec![
                        ("type".to_string(), PyV::Str("html".to_string())),
                        ("value_base64".to_string(), PyV::Str(b64)),
                    ]);
                }
            }
        }

        // 先用 get_html（最常见）
        if let Ok(ctx) = setup_clipboard() {
            if let Ok(s) = ctx.get_html() {
                if !s.trim().is_empty() {
                    return PyV::Obj(vec![
                        ("type".to_string(), PyV::Str("html".to_string())),
                        ("value".to_string(), PyV::Str(s)),
                    ]);
                }
            }

            // 再尝试 raw buffer：优先挑出包含 "html" 的格式
            if let Ok(types) = ctx.available_formats() {
                // 兼容 macOS 的 public.html；Linux 的 text/html
                let mut candidates: Vec<String> = types
                    .into_iter()
                    .filter(|t| t.to_ascii_lowercase().contains("html"))
                    .collect();

                // 稳定排序：更具体的优先
                candidates.sort_by_key(|s| s.len());

                for fmt in candidates {
                    if let Ok(buf) = ctx.get_buffer(&fmt) {
                        if buf.is_empty() {
                            continue;
                        }
                        if let Ok(s) = String::from_utf8(buf.clone()) {
                            return PyV::Obj(vec![
                                ("type".to_string(), PyV::Str("html".to_string())),
                                ("value".to_string(), PyV::Str(s)),
                            ]);
                        }
                        let b64 = general_purpose::STANDARD.encode(buf);
                        return PyV::Obj(vec![
                            ("type".to_string(), PyV::Str("html".to_string())),
                            ("value_base64".to_string(), PyV::Str(b64)),
                        ]);
                    }
                }
            }
        }

        PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))])
    }

    pub fn handle_clipboard(output_dir: &Path) -> PyV {
        // 行为对齐（优先级）：files > image > text > unknown

        // 1) 文件/文件夹
        let raw_paths = read_files_from_clipboard();
        if !raw_paths.is_empty() {
            let mut src_dirs: Vec<PathBuf> = Vec::new();
            let mut src_files: Vec<PathBuf> = Vec::new();

            for p in raw_paths {
                if p.exists() {
                    if p.is_dir() {
                        src_dirs.push(p);
                    } else if p.is_file() {
                        src_files.push(p);
                    }
                }
            }

            let mut copied_dirs: Vec<String> = Vec::new();
            let mut copied_files: Vec<String> = Vec::new();

            if !src_dirs.is_empty() {
                for d in src_dirs {
                    if let Some(dst) = copytree_parallel(&d, output_dir) {
                        copied_dirs.push(dst);
                    }
                }
            }

            if !src_files.is_empty() {
                copied_files = copy_files_parallel(src_files, output_dir);
            }

            if !copied_dirs.is_empty() || !copied_files.is_empty() {
                let folders_v = copied_dirs.into_iter().map(PyV::Str).collect::<Vec<PyV>>();
                let files_v = copied_files.into_iter().map(PyV::Str).collect::<Vec<PyV>>();
                return PyV::Obj(vec![
                    ("type".to_string(), PyV::Str("file_folder".to_string())),
                    ("folders".to_string(), PyV::Arr(folders_v)),
                    ("files".to_string(), PyV::Arr(files_v)),
                ]);
            }

            return PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))]);
        }

        // 2) 图片
        if let Some(png_bytes) = read_image_png_bytes_from_clipboard() {
            let _ = fs::create_dir_all(output_dir);
            let fname = get_timestamp_filename(".png");
            let out_path = unique_path_in_dir(output_dir, &fname);
            ensure_parent(&out_path);

            if fs::write(&out_path, png_bytes).is_ok() {
                return PyV::Obj(vec![
                    ("type".to_string(), PyV::Str("image".to_string())),
                    ("path".to_string(), PyV::Str(out_path.to_string_lossy().to_string())),
                ]);
            }

            return PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))]);
        }

        // 3) 文本
        if let Some(text) = read_text_from_clipboard() {
            return PyV::Obj(vec![
                ("type".to_string(), PyV::Str("text".to_string())),
                ("text".to_string(), PyV::Str(text)),
            ]);
        }

        PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))])
    }

    pub fn get_file_icon_base64(file_path: &str) -> Option<String> {
        #[cfg(feature = "icons")]
        {
            // file_icon_provider: pixels 已经是 RGBA。Linux caveat：必须在主线程调用（我们在 dispatch_action 里主线程调用）。
            let icon = get_file_icon(file_path, 16).ok()?;
            if icon.width == 0 || icon.height == 0 {
                return None;
            }
            if icon.pixels.len() != (icon.width as usize) * (icon.height as usize) * 4 {
                return None;
            }
            let png = png_bytes_from_rgba(icon.width, icon.height, &icon.pixels).ok()?;
            Some(general_purpose::STANDARD.encode(png))
        }

        #[cfg(not(feature = "icons"))]
        {
            let _ = file_path;
            None
        }
    }

    // 用于更“硬核”的诊断：Wayland 是否能拿到 HTML/Files
    #[allow(dead_code)]
    #[cfg(target_os = "linux")]
    fn _debug_wayland_types() -> Option<Vec<String>> {
        if is_wayland_session() && has_wl_paste() {
            wl_paste_list_types()
        } else {
            None
        }
    }
}

// =============================================================================
//  _dispatch_action / daemon / main —— 对齐 Python
// =============================================================================

fn dispatch_action(cmd_v: &Value) -> (PyV, bool, bool) {
    // returns: (response_value, exit_now, exit_ensure_ascii_false)

    let cmd = match cmd_v.as_object() {
        Some(o) => o,
        None => {
            let out = PyV::Obj(vec![
                ("_id".to_string(), py_num_u64(0)),
                ("error".to_string(), PyV::Str("cmd is not an object".to_string())),
            ]);
            return (out, false, false);
        }
    };

    let request_id = pick_request_id(cmd);
    let mut out_pairs: Vec<(String, PyV)> = vec![("_id".to_string(), request_id)];

    let a1 = cmd.get("action");
    let a2 = cmd.get("cmd");

    let action_v: Option<&Value> = if let Some(v) = a1 {
        if is_truthy(v) { Some(v) } else { None }
    } else {
        None
    }
    .or_else(|| {
        if let Some(v) = a2 {
            if is_truthy(v) { Some(v) } else { None }
        } else {
            None
        }
    });

    let action_s = action_v.and_then(|v| v.as_str()).unwrap_or("");

    match action_s {
        "ping" => {
            out_pairs.push(("status".to_string(), PyV::Str("alive".to_string())));
            (PyV::Obj(out_pairs), false, false)
        }
        "extract_icon" => {
            let path = cmd.get("path").and_then(|v| v.as_str());
            if let Some(p) = path {
                if let Some(icon) = platform::get_file_icon_base64(p) {
                    out_pairs.push(("icon".to_string(), PyV::Str(icon)));
                    out_pairs.push(("status".to_string(), PyV::Str("ok".to_string())));
                } else {
                    out_pairs.push(("status".to_string(), PyV::Str("error".to_string())));
                    out_pairs.push((
                        "message".to_string(),
                        PyV::Str("icon extraction failed".to_string()),
                    ));
                }
            } else {
                out_pairs.push(("status".to_string(), PyV::Str("error".to_string())));
                out_pairs.push(("message".to_string(), PyV::Str("no path provided".to_string())));
            }
            (PyV::Obj(out_pairs), false, false)
        }
        "clipboard_peek" | "peek" => {
            out_pairs.push(("type".to_string(), PyV::Str("peek".to_string())));
            (PyV::Obj(out_pairs), false, false)
        }
        "get_clipboard_files" => {
            if let PyV::Obj(extra) = platform::get_clipboard_files_only() {
                out_pairs.extend(extra);
            }
            (PyV::Obj(out_pairs), false, false)
        }
        "get_html" => {
            if let PyV::Obj(extra) = platform::get_clipboard_html() {
                out_pairs.extend(extra);
            }
            (PyV::Obj(out_pairs), false, false)
        }
        "exit" => {
            out_pairs.push(("status".to_string(), PyV::Str("exiting".to_string())));
            (PyV::Obj(out_pairs), true, true)
        }
        "clipboard" | "paste" => {
            let target_dir = cmd
                .get("target_dir")
                .and_then(|v| v.as_str())
                .or_else(|| cmd.get("output_dir").and_then(|v| v.as_str()));
            let output_dir = resolve_output_dir(target_dir);
            if let PyV::Obj(extra) = platform::handle_clipboard(&output_dir) {
                out_pairs.extend(extra);
            }
            (PyV::Obj(out_pairs), false, false)
        }
        "folder_info" | "get_folder_info" => {
            let path = cmd.get("path").and_then(|v| v.as_str()).unwrap_or("");
            if let PyV::Obj(extra) = get_folder_info(path) {
                out_pairs.extend(extra);
            }
            (PyV::Obj(out_pairs), false, false)
        }
        _ => {
            let msg = format!("unknown action: {}", py_str_like(action_v));
            out_pairs.push(("error".to_string(), PyV::Str(msg)));
            (PyV::Obj(out_pairs), false, false)
        }
    }
}

fn daemon_mode() {
    eprintln!("Daemon started. PID={}", process::id());

    let stdin = io::stdin();
    let mut reader = stdin.lock();

    loop {
        let mut line_bytes: Vec<u8> = Vec::new();
        match reader.read_until(b'\n', &mut line_bytes) {
            Ok(0) => {
                eprintln!("Daemon stdin EOF.");
                thread::sleep(Duration::from_secs(1));
                continue;
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("Daemon loop error: {}", e);
                thread::sleep(Duration::from_millis(50));
                continue;
            }
        }

        let line = decode_utf8_ignore(&line_bytes);
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let parsed: Result<Value, _> = serde_json::from_str(&line);

        let (res, exit_now, exit_ascii_false) = match parsed {
            Ok(cmd) => dispatch_action(&cmd),
            Err(e) => {
                let out = PyV::Obj(vec![
                    ("_id".to_string(), py_num_u64(0)),
                    ("error".to_string(), PyV::Str(e.to_string())),
                ]);
                (out, false, false)
            }
        };

        let ensure_ascii = !exit_ascii_false;
        let s = dumps_py(&res, ensure_ascii);

        let mut stdout = io::stdout();
        let _ = stdout.write_all(s.as_bytes());
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();

        if exit_now {
            process::exit(0);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() > 1 {
        let arg1 = args[1].trim().to_lowercase();

        if arg1 == "--daemon" || arg1 == "daemon" || arg1 == "-d" {
            daemon_mode();
            return;
        }

        if arg1 == "paste" && args.len() >= 3 {
            let output_dir = resolve_output_dir(Some(args[2].as_str()));
            let res = platform::handle_clipboard(&output_dir);
            let s = dumps_py(&res, true); // ensure_ascii=True
            println!("{}", s);
            return;
        }

        // default
        let output_dir = resolve_output_dir(None);
        let res = platform::handle_clipboard(&output_dir);
        let s = dumps_py(&res, true);
        println!("{}", s);
    } else {
        let output_dir = resolve_output_dir(None);
        let res = platform::handle_clipboard(&output_dir);
        let s = dumps_py(&res, true);
        println!("{}", s);
    }
}
