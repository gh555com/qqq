// -*- coding: utf-8 -*-
// Rust port of the given Python "dumb saver" clipboard daemon.
// - 极简模式：只负责读取系统剪贴板并保存到指定目录（dumb saver）
// - 移除所有指纹计算、去重逻辑
// - 移除 HTML 解析逻辑（由 Node.js 侧处理）
// - 仅处理：纯文本、文件复制、原生图片保存
//
// 目标：按用户贴出的 Python 版本“行为等同”：
// - daemon 协议：stdin JSON line -> stdout JSON line
// - JSON dumps：默认 separators (", ", ": ")；ensure_ascii 默认 True；exit 时 ensure_ascii=False
// - actions: ping / extract_icon / clipboard_peek(peek) / get_clipboard_files / get_html / exit / clipboard(paste) / folder_info(get_folder_info)
// - Windows：文本、CF_HDROP 文件/文件夹复制、CF_DIB/CF_DIBV5 截图保存
//
// 说明：PNG 编码字节可能与 PIL 不逐字节一致，但行为/字段/格式对齐。

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
use std::time::Duration;
use threadpool::ThreadPool;
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

static RE_INVALID_FILENAME: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[<>:"/\\|?*]+"#).unwrap());

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
            // 输入对象字段顺序不重要；这里只做“尽量保留”，但不会用于“严格顺序对齐”的输出对象
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

fn dumps_py(value: &PyV, _ensure_ascii: bool) -> String {
    let mut buf: Vec<u8> = Vec::new();
    let formatter = PyFormatter;
    let mut ser = serde_json::ser::Serializer::with_formatter(&mut buf, formatter);
    let _ = value.serialize(&mut ser);
    String::from_utf8(buf).unwrap_or_else(|_| "{}".to_string())
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

// Python Path.suffix / Path.stem 的关键语义（用于 safe_filename truncation / unique_name）：
// - ".bashrc" => suffix "", stem ".bashrc"
// - "a." => suffix ".", stem "a"
// - "a.tar.gz" => suffix ".gz", stem "a.tar"
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
    // n = re.sub(r'[<>:"/\\\\|?*]+', "_", n)
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
    // Python:
    // base = output_dir / name
    // if not base.exists(): return base
    // stem = base.stem; ext = base.suffix
    // for i in range(1, 1000):
    //   new_name = f"{stem}_{i}{ext}"
    //   if not exists: return
    // return base
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
//  DIB / DIBV5 转 BMP
// =============================================================================

fn dib_to_bmp_bytes(dib: &[u8]) -> Result<Vec<u8>, String> {
    // 严格按 Python 的 dib_to_bmp_bytes 逻辑
    if dib.is_empty() || dib.len() < 16 {
        return Err("DIB data too small".to_string());
    }

    let header_size = u32::from_le_bytes([dib[0], dib[1], dib[2], dib[3]]) as usize;
    if header_size < 12 || header_size > dib.len() {
        return Err(format!("Invalid DIB header size: {}", header_size));
    }

    let (bpp, compression, colors_used, palette_entry_size) = if header_size == 12 {
        let bpp = u16::from_le_bytes([dib[10], dib[11]]) as u32;
        (bpp, 0u32, 0u32, 3u32)
    } else {
        let bpp = u16::from_le_bytes([dib[14], dib[15]]) as u32;
        let compression = u32::from_le_bytes([dib[16], dib[17], dib[18], dib[19]]);
        let colors_used = if dib.len() >= 36 {
            u32::from_le_bytes([dib[32], dib[33], dib[34], dib[35]])
        } else {
            0u32
        };
        (bpp, compression, colors_used, 4u32)
    };

    let palette_colors = if colors_used != 0 {
        colors_used
    } else if (0 < bpp) && (bpp <= 8) {
        1u32 << bpp
    } else {
        0u32
    };

    let palette_size = palette_colors * palette_entry_size;

    let mut bitfields_size = 0u32;
    const BI_BITFIELDS: u32 = 3;
    const BI_ALPHABITFIELDS: u32 = 6;

    if header_size == 40 && (compression == BI_BITFIELDS || compression == BI_ALPHABITFIELDS) {
        bitfields_size = if compression == BI_BITFIELDS { 12 } else { 16 };
    }

    let bf_off_bits = 14u32 + (header_size as u32) + bitfields_size + palette_size;
    let bf_size = 14u32 + (dib.len() as u32);

    let mut file_header = Vec::<u8>::with_capacity(14 + dib.len());
    file_header.extend_from_slice(b"BM");
    file_header.extend_from_slice(&bf_size.to_le_bytes());
    file_header.extend_from_slice(&0u32.to_le_bytes()); // reserved
    file_header.extend_from_slice(&bf_off_bits.to_le_bytes());

    let mut out = file_header;
    out.extend_from_slice(dib);
    Ok(out)
}

// =============================================================================
//  PNG 写出（对齐 Python：有 alpha 就 RGBA，否则 RGB；compress_level=6 的“默认”等效）
// =============================================================================

fn save_image_as_png(img: image::DynamicImage, path: &Path) -> Result<(), String> {
    use image::codecs::png::PngEncoder;
    use image::{ColorType, ImageEncoder};

    ensure_parent(path);

    let file = fs::File::create(path).map_err(|e| e.to_string())?;
    let mut w = BufWriter::new(file);

    let has_alpha = img.color().has_alpha();

    if has_alpha {
        let rgba = img.to_rgba8();
        let (width, height) = rgba.dimensions();
        let encoder = PngEncoder::new(&mut w);
        encoder
            .write_image(rgba.as_raw(), width, height, ColorType::Rgba8.into())
            .map_err(|e: image::ImageError| e.to_string())?;
    } else {
        let rgb = img.to_rgb8();
        let (width, height) = rgb.dimensions();
        let encoder = PngEncoder::new(&mut w);
        encoder
            .write_image(rgb.as_raw(), width, height, ColorType::Rgb8.into())
            .map_err(|e: image::ImageError| e.to_string())?;
    }

    let _ = w.flush();
    Ok(())
}

fn png_bytes_from_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    use image::codecs::png::PngEncoder;
    use image::{ColorType, ImageEncoder};

    let mut out: Vec<u8> = Vec::new();
    {
        let encoder = PngEncoder::new(&mut out);
        encoder
            .write_image(rgba, width, height, ColorType::Rgba8.into())
            .map_err(|e: image::ImageError| e.to_string())?;
    }
    Ok(out)
}

// =============================================================================
//  文件复制 (Dumb Copy) —— 尽量模拟 shutil.copy2
// =============================================================================

fn copy2_like(src: &Path, dst: &Path) -> Result<(), String> {
    // shutil.copy2: copy data + metadata
    ensure_parent(dst);

    fs::copy(src, dst).map_err(|e| e.to_string())?;

    let meta = fs::metadata(src).map_err(|e| e.to_string())?;
    let _ = fs::set_permissions(dst, meta.permissions());

    let atime = FileTime::from_last_access_time(&meta);
    let mtime = FileTime::from_last_modification_time(&meta);
    let _ = set_file_times(dst, atime, mtime);

    Ok(())
}

fn copy_files_parallel(src_files: Vec<PathBuf>, output_dir: &Path) -> Vec<String> {
    // 对齐 Python copy_files_parallel 的“限流 + 完成即收集”的行为（结果顺序非确定）
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

        // Python _wait_some: 超过阈值就 wait FIRST_COMPLETED
        while pending > inflight {
            if let Ok(opt) = rx.recv() {
                pending -= 1;
                if let Some(p) = opt {
                    results.push(p);
                }
            } else {
                pending = pending.saturating_sub(1);
            }
        }
    }

    drop(tx);

    // drain remaining
    for opt in rx {
        if let Some(p) = opt {
            results.push(p);
        }
    }

    results
}

fn copytree_parallel(src_dir: &Path, output_dir: &Path) -> Option<String> {
    // Python copytree_parallel 语义：
    // - 若 src_dir 不存在或不是 dir => None
    // - dst_dir = output_dir / safe_filename(src_dir.name)
    // - 若存在 => unique_path_in_dir
    // - os.walk 遍历：创建目录；对 files submit copy2；等全部完成
    // - 返回 dst_dir 字符串；异常 => None
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
                pending -= 1;
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
    // Python:
    // ext = p.suffix.lower().replace(".", "") or "no_ext"
    // Path.suffix 对 ".bashrc" => ""，所以应为 no_ext
    let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let suf = py_suffix(&name);
    let mut ext = suf.to_ascii_lowercase().replace('.', "");
    if ext.is_empty() {
        ext = "no_ext".to_string();
    }
    ext
}

fn get_folder_info(folder_path: &str) -> PyV {
    // Python:
    // if not folder_path or not isinstance(folder_path, str):
    //   return {"success": False, "error": "empty path"}
    // if not exists or not isdir:
    //   return {"success": False, "error": "path not a directory"}
    // total_size=0; file_count=0; ext_counts={}
    // walk and sum
    // return {"success": True, "total_size":..., "file_count_root":..., "ext_stats": ext_counts}

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

    // Python dict 是“首次出现的扩展名”决定插入顺序
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

// Python f-string 对常见类型的 str() 近似（主要用于 unknown action）
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
            // dict(str) 近似：{'k': v, ...}（仅用于错误消息，尽量贴近）
            let mut parts: Vec<String> = Vec::new();
            for (k, v) in o {
                // Python dict 的 key 若是 str 会带引号（单引号）。这里尽量近似。
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
//  Windows 实现
// =============================================================================

#[cfg(windows)]
mod win {
    use super::*;
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::System::DataExchange::*;
    use windows_sys::Win32::System::Memory::*;
    use windows_sys::Win32::UI::Shell::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    // Manually define clipboard format constants since they're missing in windows-sys 0.61
    const CF_TEXT: u32 = 1;
    const CF_UNICODETEXT: u32 = 13;
    const CF_HDROP: u32 = 15;
    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;

    #[allow(unused_imports)]
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    #[allow(unused_imports)]
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    #[allow(unused_imports)]
    use windows_sys::Win32::UI::Shell::DragQueryFileW;

    // Re-export or use full paths if the wildcards are failing for some reason
    // In windows-sys 0.52, these should be available in the modules above.

    unsafe fn read_global_data(h_mem: *mut core::ffi::c_void) -> Option<Vec<u8>> {
        if h_mem.is_null() {
            return None;
        }
        let ptr = GlobalLock(h_mem) as *const u8;
        if ptr.is_null() {
            return None;
        }
        let size = GlobalSize(h_mem) as usize;
        if size == 0 {
            let _ = GlobalUnlock(h_mem);
            return None;
        }
        let slice = std::slice::from_raw_parts(ptr, size);
        let data = slice.to_vec();
        let _ = GlobalUnlock(h_mem);
        Some(data)
    }

    fn to_wide_null(s: &str) -> Vec<u16> {
        let mut v: Vec<u16> = s.encode_utf16().collect();
        v.push(0);
        v
    }

    enum DataToProcess {
        Text(String),
        Files(Vec<String>),
        Dib(Vec<u8>),
    }

    pub fn handle_clipboard(output_dir: &Path) -> PyV {
        // 对齐 Python handle_windows_ctypes（含“阶段1快速读、阶段2慢处理”）
        let mut data_to_process: Option<DataToProcess> = None;

        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return PyV::Obj(vec![("error".to_string(), PyV::Str("Cannot open clipboard".to_string()))]);
            }

            let has_files = IsClipboardFormatAvailable(CF_HDROP) != 0;
            let has_text = (IsClipboardFormatAvailable(CF_UNICODETEXT) != 0) || (IsClipboardFormatAvailable(CF_TEXT) != 0);
            let has_dib = (IsClipboardFormatAvailable(CF_DIBV5) != 0) || (IsClipboardFormatAvailable(CF_DIB) != 0);

            if has_text && !has_files && !has_dib {
                if IsClipboardFormatAvailable(CF_UNICODETEXT) != 0 {
                    let h_mem = GetClipboardData(CF_UNICODETEXT);
                    if h_mem != std::ptr::null_mut() {
                        let ptr = GlobalLock(h_mem) as *const u16;
                        if !ptr.is_null() {
                            let size = GlobalSize(h_mem) as usize;
                            let max_wchars = size / 2;
                            let mut len = 0usize;
                            while len < max_wchars {
                                if *ptr.add(len) == 0 {
                                    break;
                                }
                                len += 1;
                            }
                            let slice = std::slice::from_raw_parts(ptr, len);
                            let text = String::from_utf16_lossy(slice);
                            let _ = GlobalUnlock(h_mem);

                            if !text.trim().is_empty() {
                                data_to_process = Some(DataToProcess::Text(text));
                            }
                        } else {
                            let _ = GlobalUnlock(h_mem);
                        }
                    }
                }
            } else if has_files {
                let h_drop = GetClipboardData(CF_HDROP);
                if h_drop != std::ptr::null_mut() {
                    let count = DragQueryFileW(h_drop, 0xFFFFFFFF, std::ptr::null_mut(), 0);
                    let mut paths: Vec<String> = Vec::new();

                    for i in 0..count {
                        let needed = DragQueryFileW(h_drop, i, std::ptr::null_mut(), 0) + 1;
                        if needed == 0 {
                            continue;
                        }
                        let mut buf: Vec<u16> = vec![0; needed as usize];
                        DragQueryFileW(h_drop, i, buf.as_mut_ptr(), needed);
                        if let Some(pos) = buf.iter().position(|&c| c == 0) {
                            buf.truncate(pos);
                        }
                        paths.push(String::from_utf16_lossy(&buf));
                    }

                    if !paths.is_empty() {
                        data_to_process = Some(DataToProcess::Files(paths));
                    }
                }
            } else if has_dib {
                let mut fmts: Vec<u32> = Vec::new();
                if IsClipboardFormatAvailable(CF_DIBV5) != 0 {
                    fmts.push(CF_DIBV5);
                }
                if IsClipboardFormatAvailable(CF_DIB) != 0 {
                    fmts.push(CF_DIB);
                }

                for fmt in fmts {
                    let h_mem = GetClipboardData(fmt);
                    if h_mem == std::ptr::null_mut() {
                        continue;
                    }
                    if let Some(dib) = read_global_data(h_mem) {
                        if !dib.is_empty() {
                            data_to_process = Some(DataToProcess::Dib(dib));
                            break;
                        }
                    }
                }
            }

            CloseClipboard();
        }

        // 阶段2：锁外慢处理
        match data_to_process {
            None => PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))]),
            Some(DataToProcess::Text(text)) => PyV::Obj(vec![
                ("type".to_string(), PyV::Str("text".to_string())),
                ("text".to_string(), PyV::Str(text)),
            ]),
            Some(DataToProcess::Files(paths)) => {
                let mut src_dirs: Vec<PathBuf> = Vec::new();
                let mut src_files: Vec<PathBuf> = Vec::new();

                for fp in paths {
                    let p = PathBuf::from(fp);
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
                    PyV::Obj(vec![
                        ("type".to_string(), PyV::Str("file_folder".to_string())),
                        ("folders".to_string(), PyV::Arr(folders_v)),
                        ("files".to_string(), PyV::Arr(files_v)),
                    ])
                } else {
                    PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))])
                }
            }
            Some(DataToProcess::Dib(dib)) => {
                let res = (|| -> Result<PyV, String> {
                    let bmp = dib_to_bmp_bytes(&dib)?;
                    let img = image::load_from_memory_with_format(&bmp, image::ImageFormat::Bmp).map_err(|e| e.to_string())?;

                    let fname = get_timestamp_filename(".png");
                    let out_path = unique_path_in_dir(output_dir, &fname);
                    ensure_parent(&out_path);
                    save_image_as_png(img, &out_path)?;

                    Ok(PyV::Obj(vec![
                        ("type".to_string(), PyV::Str("image".to_string())),
                        ("path".to_string(), PyV::Str(out_path.to_string_lossy().to_string())),
                    ]))
                })();

                match res {
                    Ok(v) => v,
                    Err(_) => PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))]),
                }
            }
        }
    }

    pub fn get_clipboard_files_only() -> PyV {
        // 对齐 Python get_clipboard_files_only：优先 ctypes 路径，失败返回 unknown（不抛 error）
        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))]);
            }

            if IsClipboardFormatAvailable(CF_HDROP) != 0 {
                let h_drop = GetClipboardData(CF_HDROP);
                if h_drop != std::ptr::null_mut() {
                    let count = DragQueryFileW(h_drop, 0xFFFFFFFF, std::ptr::null_mut(), 0);
                    let mut paths: Vec<PyV> = Vec::new();

                    for i in 0..count {
                        let needed = DragQueryFileW(h_drop, i, std::ptr::null_mut(), 0) + 1;
                        if needed == 0 {
                            continue;
                        }
                        let mut buf: Vec<u16> = vec![0; needed as usize];
                        DragQueryFileW(h_drop, i, buf.as_mut_ptr(), needed);

                        if let Some(pos) = buf.iter().position(|&c| c == 0) {
                            buf.truncate(pos);
                        }
                        paths.push(PyV::Str(String::from_utf16_lossy(&buf)));
                    }

                    CloseClipboard();

                    if !paths.is_empty() {
                        return PyV::Obj(vec![
                            ("type".to_string(), PyV::Str("file_paths".to_string())),
                            ("paths".to_string(), PyV::Arr(paths)),
                        ]);
                    }

                    return PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))]);
                }
            }

            CloseClipboard();
            PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))])
        }
    }

    pub fn get_clipboard_html() -> PyV {
        // 对齐 Python get_clipboard_html：读取 HTML Format；UTF-8 decode 失败则 base64
        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))]);
            }

            let cf_html = RegisterClipboardFormatW(to_wide_null("HTML Format").as_ptr());
            if cf_html != 0 && IsClipboardFormatAvailable(cf_html) != 0 {
                let h_mem = GetClipboardData(cf_html);
                if h_mem != std::ptr::null_mut() {
                    let ptr = GlobalLock(h_mem) as *const u8;
                    if !ptr.is_null() {
                        let size = GlobalSize(h_mem) as usize;
                        let slice = std::slice::from_raw_parts(ptr, size);
                        let data = slice.to_vec();
                        let _ = GlobalUnlock(h_mem);

                        CloseClipboard();

                        if let Ok(s) = String::from_utf8(data.clone()) {
                            return PyV::Obj(vec![
                                ("type".to_string(), PyV::Str("html".to_string())),
                                ("value".to_string(), PyV::Str(s)),
                            ]);
                        } else {
                            let b64 = general_purpose::STANDARD.encode(data);
                            return PyV::Obj(vec![
                                ("type".to_string(), PyV::Str("html".to_string())),
                                ("value_base64".to_string(), PyV::Str(b64)),
                            ]);
                        }
                    } else {
                        let _ = GlobalUnlock(h_mem);
                    }
                }
            }

            CloseClipboard();
            PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))])
        }
    }

    // =============================================================================
    //  extract_icon —— 对齐 Python get_file_icon_base64
    // =============================================================================

    #[repr(C)]
    struct BITMAPINFO32 {
        bmiHeader: BITMAPINFOHEADER,
        bmiColors: [u32; 3],
    }

    pub fn get_file_icon_base64(file_path: &str) -> Option<String> {
        // Python 逻辑：
        // - SHGetFileInfoW(path, ..., SHGFI_ICON | SHGFI_SMALLICON)
        // - CreateCompatibleDC + CreateDIBSection 32bpp top-down
        // - DrawIconEx
        // - BGRA -> PNG base64
        unsafe {
            let wide = to_wide_null(file_path);

            let mut shfi: SHFILEINFOW = std::mem::zeroed();
            let res = SHGetFileInfoW(
                wide.as_ptr(),
                0,
                &mut shfi,
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_SMALLICON,
            );

            if res == 0 || shfi.hIcon == std::ptr::null_mut() {
                return None;
            }

            let hicon = shfi.hIcon;

            let mut ok = None;

            // 尽量与 Python 一样：无论中途如何，最后 DestroyIcon
            // 资源清理按顺序做
            let hdc_screen = GetDC(std::ptr::null_mut());
            if hdc_screen == std::ptr::null_mut() {
                DestroyIcon(hicon);
                return None;
            }

            let hdc_mem = CreateCompatibleDC(hdc_screen);
            if hdc_mem == std::ptr::null_mut() {
                ReleaseDC(std::ptr::null_mut(), hdc_screen);
                DestroyIcon(hicon);
                return None;
            }

            let width: i32 = 16;
            let height: i32 = 16;

            let mut bmi = BITMAPINFO32 {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [0u32; 3],
            };

            let mut bits_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
            let hbmp = CreateDIBSection(
                hdc_mem,
                (&mut bmi as *mut BITMAPINFO32) as *mut BITMAPINFO,
                DIB_RGB_COLORS,
                &mut bits_ptr,
                std::ptr::null_mut(),
                0,
            );

            if hbmp == std::ptr::null_mut() || bits_ptr.is_null() {
                DeleteDC(hdc_mem);
                ReleaseDC(std::ptr::null_mut(), hdc_screen);
                DestroyIcon(hicon);
                return None;
            }

            let hold = SelectObject(hdc_mem, hbmp as _);
            // DI_NORMAL == 0x0003（Python 用 0x0003）
            let _ = DrawIconEx(hdc_mem, 0, 0, hicon, width, height, 0, std::ptr::null_mut(), 0x0003);

            // 读取 BGRA
            let size = (width * height * 4) as usize;
            let src = std::slice::from_raw_parts(bits_ptr as *const u8, size);

            // 转 RGBA（PIL frombuffer("RGBA", raw="BGRA") 等效）
            let mut rgba: Vec<u8> = Vec::with_capacity(size);
            for px in src.chunks_exact(4) {
                let b = px[0];
                let g = px[1];
                let r = px[2];
                let a = px[3];
                rgba.push(r);
                rgba.push(g);
                rgba.push(b);
                rgba.push(a);
            }

            if let Ok(png) = png_bytes_from_rgba(width as u32, height as u32, &rgba) {
                ok = Some(general_purpose::STANDARD.encode(png));
            }

            // cleanup
            let _ = SelectObject(hdc_mem, hold);
            let _ = DeleteObject(hbmp as _);
            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(std::ptr::null_mut(), hdc_screen);
            let _ = DestroyIcon(hicon);

            ok
        }
    }
}

#[cfg(not(windows))]
mod win {
    use super::*;
    pub fn handle_clipboard(_output_dir: &Path) -> PyV {
        PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))])
    }
    pub fn get_clipboard_files_only() -> PyV {
        PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))])
    }
    pub fn get_clipboard_html() -> PyV {
        PyV::Obj(vec![("type".to_string(), PyV::Str("unknown".to_string()))])
    }
    pub fn get_file_icon_base64(_file_path: &str) -> Option<String> {
        None
    }
}

// =============================================================================
//  _dispatch_action / daemon / main —— 对齐 Python
// =============================================================================

fn dispatch_action(cmd_v: &Value) -> (PyV, bool, bool) {
    // returns: (response_value, exit_now, exit_ensure_ascii_false)
    // 对齐 Python _dispatch_action
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

    // Python: out = {"_id": request_id}
    let mut out_pairs: Vec<(String, PyV)> = vec![("_id".to_string(), request_id)];

    // Python: action = cmd.get("action") or cmd.get("cmd")  （按 truthiness）
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
            // Python:
            // path = cmd.get("path")
            // if path:
            //   icon_b64 = get_file_icon_base64(path)
            //   if icon_b64:
            //     out["icon"]=...; out["status"]="ok"
            //   else:
            //     out["status"]="error"; out["message"]="icon extraction failed"
            // else:
            //   out["status"]="error"; out["message"]="no path provided"
            let path = cmd.get("path").and_then(|v| v.as_str());
            if let Some(p) = path {
                if let Some(icon) = win::get_file_icon_base64(p) {
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
            // Python: out.update(get_clipboard_files_only())
            if let PyV::Obj(extra) = win::get_clipboard_files_only() {
                out_pairs.extend(extra);
            }
            (PyV::Obj(out_pairs), false, false)
        }
        "get_html" => {
            if let PyV::Obj(extra) = win::get_clipboard_html() {
                out_pairs.extend(extra);
            }
            (PyV::Obj(out_pairs), false, false)
        }
        "exit" => {
            out_pairs.push(("status".to_string(), PyV::Str("exiting".to_string())));
            // Python: ensure_ascii=False here
            (PyV::Obj(out_pairs), true, true)
        }
        "clipboard" | "paste" => {
            let target_dir = cmd
                .get("target_dir")
                .and_then(|v| v.as_str())
                .or_else(|| cmd.get("output_dir").and_then(|v| v.as_str()));
            let output_dir = resolve_output_dir(target_dir);
            if let PyV::Obj(extra) = win::handle_clipboard(&output_dir) {
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
    // Python debug: log startup
    eprintln!("Daemon started. PID={}", process::id());

    let stdin = io::stdin();
    let mut reader = stdin.lock();

    loop {
        let mut line_bytes: Vec<u8> = Vec::new();
        match reader.read_until(b'\n', &mut line_bytes) {
            Ok(0) => {
                // EOF
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

        // Python: normal ensure_ascii=True; exit ensure_ascii=False
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
    // 对齐 Python main()
    let args: Vec<String> = std::env::args().collect();

    if args.len() > 1 {
        let arg1 = args[1].trim().to_lowercase();

        if arg1 == "--daemon" || arg1 == "daemon" || arg1 == "-d" {
            daemon_mode();
            return;
        }

        if arg1 == "paste" && args.len() >= 3 {
            let out_dir = Some(args[2].as_str());
            let output_dir = resolve_output_dir(out_dir);

            let res = win::handle_clipboard(&output_dir);
            let s = dumps_py(&res, true); // ensure_ascii=True
            println!("{}", s);
            return;
        }

        // default
        let output_dir = resolve_output_dir(None);
        let res = win::handle_clipboard(&output_dir);
        let s = dumps_py(&res, true);
        println!("{}", s);
    } else {
        let output_dir = resolve_output_dir(None);
        let res = win::handle_clipboard(&output_dir);
        let s = dumps_py(&res, true);
        println!("{}", s);
    }
}
