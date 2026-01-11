// -*- coding: utf-8 -*-
// Rust port of the given Python "dumb saver" clipboard daemon.
// - 极简模式：只负责读取系统剪贴板并保存到指定目录（dumb saver）
// - 移除所有指纹计算、去重逻辑
// - 移除 HTML 解析逻辑（由 Node.js 侧处理）
// - 仅处理：纯文本、文件复制、原生图片保存

use base64::{engine::general_purpose, Engine as _};
use chrono::{Datelike, Local};
use filetime::{set_file_times, FileTime};
use once_cell::sync::Lazy;
use rand::seq::SliceRandom;
use rand::thread_rng;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufRead, Read, Write};
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
    let cpu = {
        let c = num_cpus::get();
        if c == 0 { 4 } else { c }
    };
    let v = (cpu * 2).max(4);
    v.min(32)
}

static MAX_WORKERS: Lazy<usize> = Lazy::new(compute_max_workers);
static IO_POOL: Lazy<ThreadPool> = Lazy::new(|| ThreadPool::new(*MAX_WORKERS));

static RE_INVALID_FILENAME: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[<>:"/\\|?*]+"#).unwrap());

static VALID_CHARS: Lazy<Vec<char>> = Lazy::new(|| {
    // Python:
    // excluded_chars = ["l","i","s","a","m","c","b","f","t"]
    // valid_chars = [c for c in "abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    //                if c.lower() not in excluded_chars]
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
    // Python: try parent.mkdir(parents=True, exist_ok=True) except pass
    if let Some(parent) = path_obj.parent() {
        let _ = fs::create_dir_all(parent);
    }
}

// Python Path.suffix / Path.stem 滴关键语义（用于 safe_filename truncation / unique_name）：
// - ".bashrc" => suffix "", stem ".bashrc"
// - "a." => suffix ".", stem "a"
// - "a.tar.gz" => suffix ".gz", stem "a.tar"
fn py_suffix(name: &str) -> String {
    if let Some(pos) = name.rfind('.') {
        if pos == 0 {
            // leading dot only -> no suffix
            return String::new();
        }
        return name[pos..].to_string(); // includes '.'
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
        let without_g: Vec<char> = valid
            .iter()
            .copied()
            .filter(|c| c.to_ascii_lowercase() != 'g')
            .collect();
        *without_g.choose(&mut rng).unwrap_or(&'X')
    } else {
        *valid.choose(&mut rng).unwrap_or(&'X')
    };

    let random_chars = format!("{}{}", first_char, second_char);
    let prefix_code = format!("{}{}", millisecond_part, random_chars);

    let time_part = now.format("%H.%M.%S").to_string();
    format!(
        "{}_{}__[{}]__{}{}",
        prefix_code, date_part, weekday_number, time_part, ext
    )
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

    // Python len() 是“字符数”（Unicode code points）
    if n.chars().count() > 180 {
        let stem = py_stem(&n);
        let suf = py_suffix(&n); // includes '.' or empty or "."
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
    // for i in range(1,1000):
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
    // 严格按 Python 滴 dib_to_bmp_bytes 逻辑
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
//  PIL 保存：PNG（Rust 版：使用 image crate）
// =============================================================================

fn save_image_as_png(img: image::DynamicImage, path: &Path) -> Result<(), String> {
    // Python:
    // if img.mode in ("RGBA","LA") or (img.mode=="P" and "transparency" in info):
    //   img=img.convert("RGBA")
    // elif img.mode not in ("RGB",):
    //   img=img.convert("RGB")
    // img.save(... format="PNG", compress_level=6)
    //
    // Rust 这里用 image crate，尽量匹配“有 alpha 就 RGBA，否则 RGB”
    let has_alpha = img.color().has_alpha();

    ensure_parent(path);

    if has_alpha {
        let rgba = img.to_rgba8();
        let dynimg = image::DynamicImage::ImageRgba8(rgba);
        dynimg
            .save_with_format(path, image::ImageFormat::Png)
            .map_err(|e| e.to_string())
    } else {
        let rgb = img.to_rgb8();
        let dynimg = image::DynamicImage::ImageRgb8(rgb);
        dynimg
            .save_with_format(path, image::ImageFormat::Png)
            .map_err(|e| e.to_string())
    }
}

// =============================================================================
//  文件复制 (Dumb Copy) —— 尽量模拟 shutil.copy2
// =============================================================================

fn copy2_like(src: &Path, dst: &Path) -> Result<(), String> {
    // shutil.copy2: copy data + metadata
    ensure_parent(dst);

    fs::copy(src, dst).map_err(|e| e.to_string())?;

    // 尽量复制 permissions + atime/mtime（失败就返回 Err，外层会吞掉）
    let meta = fs::metadata(src).map_err(|e| e.to_string())?;
    let _ = fs::set_permissions(dst, meta.permissions());

    let atime = FileTime::from_last_access_time(&meta);
    let mtime = FileTime::from_last_modification_time(&meta);
    let _ = set_file_times(dst, atime, mtime);

    Ok(())
}

fn copy_files_parallel(src_files: Vec<PathBuf>, output_dir: &Path) -> Vec<String> {
    if src_files.is_empty() {
        return vec![];
    }

    // Python: ensure_parent(output_dir / "dummy")
    let _ = fs::create_dir_all(output_dir);

    let (tx, rx) = mpsc::channel::<Option<String>>();
    let inflight = std::cmp::max(64usize, *MAX_WORKERS * 16);
    let mut pending = 0usize;

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
            if let Ok(_any) = rx.recv() {
                pending -= 1;
                // 注意：Python 这里会在 as_completed 阶段统一收集；我们这里提前 recv 只是限流
                // 但为了保持“返回列表尽量一致滴 nondeterministic”，这里丢弃也可以；
                // 为了不丢结果，我们在下面会再把已 recv 滴结果也收集——因此这里不丢：
                // ——不过 channel 已经把它取走了，所以这里得立刻 push 到 results。
                // 结论：这里不能丢。我们改为“限流 recv 也收集”：
                // （实现见下方：我们用一个临时缓冲收集）
            } else {
                pending = pending.saturating_sub(1);
            }
        }
    }

    drop(tx);

    // 上面限流 recv 滴“结果不能丢”滴问题：
    // 由于我们已经把结果 recv 出来了，必须保存。
    // 为了不把结构搞乱，这里改成：不在上面 recv，直接提交全部任务，然后统一收集。
    // 但这会偏离 Python 滴 inflight 限制策略。
    // ——因此这里用一个更接近 Python 滴写法：重写 copy_files_parallel，见下方 v2。

    // 为避免重复/矛盾，这里直接走 v2：
    collect_copy_files_parallel(rx)
}

fn collect_copy_files_parallel(_rx: mpsc::Receiver<Option<String>>) -> Vec<String> {
    // 这个函数不会被使用（因为上面 copy_files_parallel 滴限流 recv 会丢结果）
    // 我们在下面提供一个正确版本 copy_files_parallel_v2，并在 windows 处理里使用它。
    vec![]
}

fn copy_files_parallel_v2(src_files: Vec<PathBuf>, output_dir: &Path) -> Vec<String> {
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

        // Python _wait_some: 超过阈值就等待 FIRST_COMPLETED，并把 done 移出集合
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

    let dir_name = src_dir.file_name().map(|s| s.to_string_lossy().to_string())?;
    let dst_name = safe_filename(&dir_name);

    let mut dst_dir = output_dir.join(&dst_name);
    if dst_dir.exists() {
        dst_dir = unique_path_in_dir(output_dir, &dst_name);
    }

    if fs::create_dir_all(&dst_dir).is_err() {
        return None;
    }

    // 处理：若 src_dir 本身是 symlink dir，WalkDir 不 follow_links 会不下钻；
    // Python 行为是能走进去（作为 root），因此这里 canonicalize 一下 root（失败就用原始）
    let walk_root = match fs::symlink_metadata(src_dir) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(src_dir).unwrap_or_else(|_| src_dir.to_path_buf()),
        _ => src_dir.to_path_buf(),
    };

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
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let suf = py_suffix(&name); // includes '.' or empty
    let mut ext = suf.to_ascii_lowercase().replace('.', "");
    if ext.is_empty() {
        ext = "no_ext".to_string();
    }
    ext
}

fn get_folder_info(folder_path: &str) -> Map<String, Value> {
    // Python:
    // if not folder_path or not isinstance(folder_path,str):
    //   return {"success":False,"error":"empty path"}
    // if not exists or not isdir:
    //   return {"success":False,"error":"path not a directory"}
    // total_size=0; file_count=0; ext_counts={}
    // walk and sum
    // return {"success":True,"total_size":...,"file_count_root":...,"ext_stats":...}

    let mut out = Map::<String, Value>::new();

    if folder_path.is_empty() {
        out.insert("success".to_string(), Value::Bool(false));
        out.insert("error".to_string(), Value::String("empty path".to_string()));
        return out;
    }

    let p = PathBuf::from(folder_path);
    if !p.exists() || !p.is_dir() {
        out.insert("success".to_string(), Value::Bool(false));
        out.insert(
            "error".to_string(),
            Value::String("path not a directory".to_string()),
        );
        return out;
    }

    let mut total_size: u64 = 0;
    let mut file_count: u64 = 0;
    let mut ext_counts: BTreeMap<String, u64> = BTreeMap::new();

    for entry in WalkDir::new(&p).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.file_type().is_dir() {
            continue;
        }

        let sp = entry.path();

        match fs::metadata(sp) {
            Ok(meta) => {
                total_size = total_size.saturating_add(meta.len());
                file_count = file_count.saturating_add(1);

                let ext = python_like_ext_lower(sp);
                *ext_counts.entry(ext).or_insert(0) += 1;
            }
            Err(_) => continue,
        }
    }

    // ext_stats 需要是 JSON object
    let mut ext_stats = Map::<String, Value>::new();
    for (k, v) in ext_counts {
        ext_stats.insert(k, Value::Number(serde_json::Number::from(v)));
    }

    out.insert("success".to_string(), Value::Bool(true));
    out.insert(
        "total_size".to_string(),
        Value::Number(serde_json::Number::from(total_size)),
    );
    out.insert(
        "file_count_root".to_string(),
        Value::Number(serde_json::Number::from(file_count)),
    );
    out.insert("ext_stats".to_string(), Value::Object(ext_stats));
    out
}

// =============================================================================
//  Windows clipboard handlers
// =============================================================================

#[cfg(windows)]
mod winclip {
    use super::*;
    use windows_sys::Win32::System::DataExchange::*;
    use windows_sys::Win32::System::Memory::*;
    use windows_sys::Win32::UI::Shell::*;

    unsafe fn read_global_data(h_mem: isize) -> Option<Vec<u8>> {
        if h_mem == 0 {
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

    pub fn handle_clipboard_windows(output_dir: &Path) -> Map<String, Value> {
        // 对齐 Python handle_windows_ctypes（含“阶段1快速读、阶段2慢处理”）
        let mut data_to_process: Option<DataToProcess> = None;

        unsafe {
            if OpenClipboard(0) == 0 {
                let mut out = Map::new();
                out.insert(
                    "error".to_string(),
                    Value::String("Cannot open clipboard".to_string()),
                );
                return out;
            }

            // 必须尽快 CloseClipboard
            let has_files = IsClipboardFormatAvailable(CF_HDROP) != 0;
            let has_text = (IsClipboardFormatAvailable(CF_UNICODETEXT) != 0)
                || (IsClipboardFormatAvailable(CF_TEXT) != 0);
            let has_dib =
                (IsClipboardFormatAvailable(CF_DIBV5) != 0) || (IsClipboardFormatAvailable(CF_DIB) != 0);

            if has_text && !has_files && !has_dib {
                if IsClipboardFormatAvailable(CF_UNICODETEXT) != 0 {
                    let h_mem = GetClipboardData(CF_UNICODETEXT);
                    if h_mem != 0 {
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
                if h_drop != 0 {
                    let count = DragQueryFileW(h_drop, 0xFFFFFFFF, std::ptr::null_mut(), 0);
                    let mut paths: Vec<String> = Vec::new();

                    for i in 0..count {
                        let needed = DragQueryFileW(h_drop, i, std::ptr::null_mut(), 0) + 1;
                        if needed == 0 {
                            continue;
                        }
                        let mut buf: Vec<u16> = vec![0; needed as usize];
                        DragQueryFileW(h_drop, i, buf.as_mut_ptr(), needed);

                        // truncate at NUL
                        if let Some(pos) = buf.iter().position(|&c| c == 0) {
                            buf.truncate(pos);
                        }
                        let s = String::from_utf16_lossy(&buf);
                        paths.push(s);
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
                    if h_mem == 0 {
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
            None => {
                let mut out = Map::new();
                out.insert("type".to_string(), Value::String("unknown".to_string()));
                out
            }
            Some(DataToProcess::Text(text)) => {
                let mut out = Map::new();
                out.insert("type".to_string(), Value::String("text".to_string()));
                out.insert("text".to_string(), Value::String(text));
                out
            }
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
                    copied_files = copy_files_parallel_v2(src_files, output_dir);
                }

                if !copied_dirs.is_empty() || !copied_files.is_empty() {
                    let mut out = Map::new();
                    out.insert("type".to_string(), Value::String("file_folder".to_string()));

                    let folders_v = copied_dirs
                        .into_iter()
                        .map(Value::String)
                        .collect::<Vec<Value>>();
                    let files_v = copied_files
                        .into_iter()
                        .map(Value::String)
                        .collect::<Vec<Value>>();

                    out.insert("folders".to_string(), Value::Array(folders_v));
                    out.insert("files".to_string(), Value::Array(files_v));
                    out
                } else {
                    let mut out = Map::new();
                    out.insert("type".to_string(), Value::String("unknown".to_string()));
                    out
                }
            }
            Some(DataToProcess::Dib(dib)) => {
                // dib -> bmp bytes -> image decode -> png save
                let res = (|| -> Result<Map<String, Value>, String> {
                    let bmp = dib_to_bmp_bytes(&dib)?;
                    let img = image::load_from_memory_with_format(&bmp, image::ImageFormat::Bmp)
                        .map_err(|e| e.to_string())?;

                    let fname = get_timestamp_filename(".png");
                    let out_path = unique_path_in_dir(output_dir, &fname);
                    ensure_parent(&out_path);
                    save_image_as_png(img, &out_path)?;

                    let mut out = Map::new();
                    out.insert("type".to_string(), Value::String("image".to_string()));
                    out.insert(
                        "path".to_string(),
                        Value::String(out_path.to_string_lossy().to_string()),
                    );
                    Ok(out)
                })();

                match res {
                    Ok(m) => m,
                    Err(_) => {
                        let mut out = Map::new();
                        out.insert("type".to_string(), Value::String("unknown".to_string()));
                        out
                    }
                }
            }
        }
    }

    pub fn get_clipboard_files_only() -> Map<String, Value> {
        // 对齐 Python get_clipboard_files_only：优先 ctypes 路径，失败返回 unknown（不抛 error）
        unsafe {
            if OpenClipboard(0) == 0 {
                let mut out = Map::new();
                out.insert("type".to_string(), Value::String("unknown".to_string()));
                return out;
            }

            let mut out = Map::new();

            if IsClipboardFormatAvailable(CF_HDROP) != 0 {
                let h_drop = GetClipboardData(CF_HDROP);
                if h_drop != 0 {
                    let count = DragQueryFileW(h_drop, 0xFFFFFFFF, std::ptr::null_mut(), 0);
                    let mut paths: Vec<Value> = Vec::new();

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
                        let s = String::from_utf16_lossy(&buf);
                        paths.push(Value::String(s));
                    }

                    CloseClipboard();

                    if !paths.is_empty() {
                        out.insert("type".to_string(), Value::String("file_paths".to_string()));
                        out.insert("paths".to_string(), Value::Array(paths));
                        return out;
                    }

                    out.insert("type".to_string(), Value::String("unknown".to_string()));
                    return out;
                }
            }

            CloseClipboard();
            out.insert("type".to_string(), Value::String("unknown".to_string()));
            out
        }
    }

    pub fn get_clipboard_html() -> Map<String, Value> {
        // 对齐 Python get_clipboard_html：读取 HTML Format；UTF-8 decode 失败则 base64
        unsafe {
            if OpenClipboard(0) == 0 {
                let mut out = Map::new();
                out.insert("type".to_string(), Value::String("unknown".to_string()));
                return out;
            }

            let cf_html = RegisterClipboardFormatW(to_wide_null("HTML Format").as_ptr());
            if cf_html != 0 && IsClipboardFormatAvailable(cf_html) != 0 {
                let h_mem = GetClipboardData(cf_html);
                if h_mem != 0 {
                    // read bytes
                    let ptr = GlobalLock(h_mem) as *const u8;
                    if !ptr.is_null() {
                        let size = GlobalSize(h_mem) as usize;
                        let slice = std::slice::from_raw_parts(ptr, size);
                        let data = slice.to_vec();
                        let _ = GlobalUnlock(h_mem);

                        CloseClipboard();

                        if let Ok(s) = String::from_utf8(data.clone()) {
                            let mut out = Map::new();
                            out.insert("type".to_string(), Value::String("html".to_string()));
                            out.insert("value".to_string(), Value::String(s));
                            return out;
                        } else {
                            let b64 = general_purpose::STANDARD.encode(data);
                            let mut out = Map::new();
                            out.insert("type".to_string(), Value::String("html".to_string()));
                            out.insert("value_base64".to_string(), Value::String(b64));
                            return out;
                        }
                    } else {
                        let _ = GlobalUnlock(h_mem);
                    }
                }
            }

            CloseClipboard();

            let mut out = Map::new();
            out.insert("type".to_string(), Value::String("unknown".to_string()));
            out
        }
    }
}

#[cfg(not(windows))]
mod winclip {
    use super::*;

    pub fn handle_clipboard_windows(_output_dir: &Path) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("type".to_string(), Value::String("unknown".to_string()));
        out
    }

    pub fn get_clipboard_files_only() -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("type".to_string(), Value::String("unknown".to_string()));
        out
    }

    pub fn get_clipboard_html() -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("type".to_string(), Value::String("unknown".to_string()));
        out
    }
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

fn dumps_py(value: &Value, ensure_ascii: bool) -> String {
    let mut buf: Vec<u8> = Vec::new();
    let formatter = PyFormatter;
    let mut ser = serde_json::ser::Serializer::with_formatter(&mut buf, formatter);
    ser.escape_non_ascii(ensure_ascii);
    value.serialize(&mut ser).unwrap_or(());
    String::from_utf8(buf).unwrap_or_else(|_| "{}".to_string())
}

// =============================================================================
//  Daemon / CLI
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

fn merge_map(dst: &mut Map<String, Value>, src: Map<String, Value>) {
    for (k, v) in src {
        dst.insert(k, v);
    }
}

fn pick_request_id(cmd: &Map<String, Value>) -> Value {
    // Python: request_id = cmd.get("_id", cmd.get("id", 0))
    if cmd.contains_key("_id") {
        cmd.get("_id").cloned().unwrap_or(Value::Null)
    } else if cmd.contains_key("id") {
        cmd.get("id").cloned().unwrap_or(Value::Number(serde_json::Number::from(0)))
    } else {
        Value::Number(serde_json::Number::from(0))
    }
}

// Python 风格滴 truthiness（仅用于 action = cmd.get("action") or cmd.get("cmd")）
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

// 用于 unknown action 错误字符串（尽量贴近 Python str(...) 对常见 JSON 类型）
fn py_str(v: Option<&Value>) -> String {
    match v {
        None => "None".to_string(),
        Some(Value::Null) => "None".to_string(),
        Some(Value::Bool(true)) => "True".to_string(),
        Some(Value::Bool(false)) => "False".to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(), // 复杂类型不强求完全一致
    }
}

fn dispatch_action(cmd_v: &Value) -> (Value, bool, bool) {
    // returns: (response_value, exit_now, exit_ensure_ascii_false)
    // 对齐 Python _dispatch_action
    let cmd = match cmd_v.as_object() {
        Some(o) => o,
        None => {
            let mut out = Map::new();
            out.insert("_id".to_string(), Value::Number(serde_json::Number::from(0)));
            out.insert("error".to_string(), Value::String("cmd is not an object".to_string()));
            return (Value::Object(out), false, false);
        }
    };

    let request_id = pick_request_id(cmd);

    let mut out = Map::<String, Value>::new();
    out.insert("_id".to_string(), request_id);

    // Python: action = cmd.get("action") or cmd.get("cmd")
    let a1 = cmd.get("action");
    let a2 = cmd.get("cmd");
    let action_v = if let Some(v) = a1 {
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
            out.insert("status".to_string(), Value::String("alive".to_string()));
            (Value::Object(out), false, false)
        }
        "clipboard_peek" | "peek" => {
            out.insert("type".to_string(), Value::String("peek".to_string()));
            (Value::Object(out), false, false)
        }
        "get_clipboard_files" => {
            let extra = winclip::get_clipboard_files_only();
            merge_map(&mut out, extra);
            (Value::Object(out), false, false)
        }
        "get_html" => {
            let extra = winclip::get_clipboard_html();
            merge_map(&mut out, extra);
            (Value::Object(out), false, false)
        }
        "exit" => {
            // Python: ensure_ascii=False here
            out.insert("status".to_string(), Value::String("exiting".to_string()));
            (Value::Object(out), true, true)
        }
        "clipboard" | "paste" => {
            let target_dir = cmd
                .get("target_dir")
                .and_then(|v| v.as_str())
                .or_else(|| cmd.get("output_dir").and_then(|v| v.as_str()));

            let output_dir = resolve_output_dir(target_dir);
            let extra = winclip::handle_clipboard_windows(&output_dir);
            merge_map(&mut out, extra);
            (Value::Object(out), false, false)
        }
        "folder_info" | "get_folder_info" => {
            let path = cmd.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let extra = get_folder_info(path);
            merge_map(&mut out, extra);
            (Value::Object(out), false, false)
        }
        _ => {
            let msg = format!("unknown action: {}", py_str(action_v));
            out.insert("error".to_string(), Value::String(msg));
            (Value::Object(out), false, false)
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
                let mut out = Map::new();
                out.insert("_id".to_string(), Value::Number(serde_json::Number::from(0)));
                out.insert("error".to_string(), Value::String(e.to_string()));
                (Value::Object(out), false, false)
            }
        };

        // Python: normal ensure_ascii=True; exit ensure_ascii=False
        let ensure_ascii = !exit_ascii_false;
        let s = dumps_py(&res, ensure_ascii);

        // 按 Python print 一行
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
            let out_dir = Some(args[2].as_str());
            let output_dir = resolve_output_dir(out_dir);
            let res_map = winclip::handle_clipboard_windows(&output_dir);
            let res = Value::Object(res_map);
            let s = dumps_py(&res, true); // ensure_ascii=True
            println!("{}", s);
            return;
        }

        // default
        let output_dir = resolve_output_dir(None);
        let res_map = winclip::handle_clipboard_windows(&output_dir);
        let res = Value::Object(res_map);
        let s = dumps_py(&res, true);
        println!("{}", s);
    } else {
        let output_dir = resolve_output_dir(None);
        let res_map = winclip::handle_clipboard_windows(&output_dir);
        let res = Value::Object(res_map);
        let s = dumps_py(&res, true);
        println!("{}", s);
    }
}
