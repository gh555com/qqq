// qqq Rust Daemon - 剪贴板处理 + 文件识别 + 文件夹统计
// 编译: cargo build --release

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

use chrono::{Datelike, Local, Timelike};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[cfg(target_os = "windows")]
use std::ffi::OsString;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStringExt;

// ==================== 常量定义 ====================

const IMAGE_EXTS: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif", ".svg",
];

// 文件签名表
const SIGNATURES: &[(&[u8], &str, &str)] = &[
    (b"\x89PNG\r\n\x1a\n", ".png", "image"),
    (b"\xff\xd8\xff", ".jpg", "image"),
    (b"GIF87a", ".gif", "gif"),
    (b"GIF89a", ".gif", "gif"),
    (b"BM", ".bmp", "image"),
    (b"\x00\x00\x01\x00", ".ico", "image"),
    (b"II*\x00", ".tif", "image"),
    (b"MM\x00*", ".tif", "image"),
    (b"%PDF", ".pdf", "document"),
    (b"PK\x03\x04", ".zip", "archive"),
    (b"Rar!", ".rar", "archive"),
    (b"\x1f\x8b\x08", ".gz", "archive"),
    (b"7z\xbc\xaf", ".7z", "archive"),
    (b"MZ", ".exe", "executable"),
    (b"\x7fELF", ".elf", "executable"),
    (b"ID3", ".mp3", "audio"),
    (b"\xff\xfb", ".mp3", "audio"),
    (b"\xff\xf3", ".mp3", "audio"),
    (b"fLaC", ".flac", "audio"),
    (b"OggS", ".ogg", "audio"),
    (b"\x1aE\xdf\xa3", ".mkv", "video"),
];

// ftyp 品牌映射
fn get_ftyp_info(brand: &[u8]) -> Option<(&str, &str)> {
    match brand {
        b"isom" | b"iso2" | b"mp41" | b"mp42" | b"avc1" => Some((".mp4", "video")),
        b"M4V " => Some((".m4v", "video")),
        b"M4A " => Some((".m4a", "audio")),
        b"qt  " => Some((".mov", "video")),
        b"heic" | b"mif1" | b"msf1" => Some((".heic", "image")),
        b"avif" => Some((".avif", "image")),
        _ => None,
    }
}

// 视频编解码器
const VIDEO_CODECS: &[&str] = &[
    "h264", "h265", "hevc", "vp8", "vp9", "av1", "mpeg4", "mpeg2video",
    "prores", "wmv3", "vc1", "theora", "rv40", "flv1", "msmpeg4v3",
];

// 图片编解码器
const IMAGE_CODECS: &[&str] = &[
    "mjpeg", "png", "bmp", "tiff", "webp", "gif", "jpegls", "pam", "pgm", "ppm",
];

// ==================== 数据结构 ====================

#[derive(Debug, Serialize, Deserialize)]
struct CommandRequest {
    #[serde(rename = "_id")]
    id: Option<i64>,
    action: String,
    path: Option<String>,
    target_dir: Option<String>,
}

#[derive(Debug, Serialize, Default)]
struct IdentifyResult {
    #[serde(rename = "_id")]
    id: i64,
    path: String,
    ext: String,
    #[serde(rename = "type")]
    file_type: String,
    codec: Option<String>,
    codec_long_name: Option<String>,
    width: Option<i32>,
    height: Option<i32>,
    duration: f64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize, Default)]
struct FolderInfoResult {
    #[serde(rename = "_id")]
    id: i64,
    success: bool,
    total_size: u64,
    ext_stats: HashMap<String, u32>,
    file_count_root: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct ClipboardResult {
    #[serde(rename = "_id")]
    id: i64,
    #[serde(rename = "type")]
    result_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ikges: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ==================== 工具函数 ====================

fn get_timestamp_filename(ext: &str) -> String {
    let now = Local::now();
    let date_part = format!("{}.{:02}.{:02}", now.year(), now.month(), now.day());
    let time_part = format!("{:02}.{:02}.{:02}", now.hour(), now.minute(), now.second());
    let weekday = now.weekday().num_days_from_monday() + 1;
    let ms = now.timestamp_subsec_millis();

    let excluded: &[char] = &['l', 'i', 's', 'a', 'm', 'c', 'b', 'f', 't', 'L', 'I', 'S', 'A', 'M', 'C', 'B', 'F', 'T'];
    let valid_chars: Vec<char> = "abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        .chars()
        .filter(|c| !excluded.contains(&c.to_ascii_lowercase()))
        .collect();

    let mut rng = rand::thread_rng();
    let first_char = valid_chars[rng.gen_range(0..valid_chars.len())];
    let second_char = if first_char.to_ascii_lowercase() == 'g' {
        let without_g: Vec<char> = valid_chars.iter().filter(|c| c.to_ascii_lowercase() != 'g').copied().collect();
        without_g[rng.gen_range(0..without_g.len())]
    } else {
        valid_chars[rng.gen_range(0..valid_chars.len())]
    };

    format!(
        "{:03}{}{}.  {} [{}] {}{}",
        ms, first_char, second_char, date_part, weekday, time_part, ext
    )
}

fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext))
}

fn ensure_dir(dir: &Path) -> io::Result<()> {
    if !dir.exists() {
        fs::create_dir_all(dir)?;
    }
    Ok(())
}

// ==================== 文件签名识别 ====================

fn detect_by_signature(file_path: &Path) -> Option<(String, String, String)> {
    let mut file = File::open(file_path).ok()?;
    let mut header = [0u8; 32];
    let bytes_read = file.read(&mut header).ok()?;

    if bytes_read < 4 {
        return None;
    }

    // 检查 ftyp (MP4/MOV 家族)
    if bytes_read >= 12 && &header[4..8] == b"ftyp" {
        let brand = &header[8..12];
        if let Some((ext, ftype)) = get_ftyp_info(brand) {
            return Some((ext.to_string(), ftype.to_string(), "signature_ftyp".to_string()));
        }
        return Some((".mp4".to_string(), "video".to_string(), "signature_ftyp".to_string()));
    }

    // 检查 WEBP (RIFF....WEBP)
    if bytes_read >= 12 && &header[0..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        return Some((".webp".to_string(), "image".to_string(), "signature".to_string()));
    }

    // 通用签名检测
    for (sig, ext, ftype) in SIGNATURES {
        if header.starts_with(sig) {
            return Some((ext.to_string(), ftype.to_string(), "signature".to_string()));
        }
    }

    None
}

// ==================== FFprobe 探测 ====================

fn probe_with_ffprobe(file_path: &Path) -> Option<Value> {
    let output = Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(file_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    serde_json::from_slice(&output.stdout).ok()
}

fn identify_file(file_path: &str, request_id: i64) -> IdentifyResult {
    let path = Path::new(file_path);
    let mut result = IdentifyResult {
        id: request_id,
        path: file_path.to_string(),
        ext: path.extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{}", e.to_lowercase()))
            .unwrap_or_default(),
        file_type: "unknown".to_string(),
        method: "none".to_string(),
        ..Default::default()
    };

    if !path.exists() {
        result.error = Some("file_not_found".to_string());
        return result;
    }

    // Layer 1: 签名检测
    if let Some((ext, ftype, method)) = detect_by_signature(path) {
        result.ext = ext;
        result.file_type = ftype;
        result.method = method;
    }

    // Layer 2: FFprobe 探测
    if matches!(result.file_type.as_str(), "image" | "video" | "gif" | "audio" | "unknown" | "animated_image") {
        if let Some(data) = probe_with_ffprobe(path) {
            let streams = data.get("streams").and_then(|s| s.as_array());
            let format_info = data.get("format");

            let mut video_stream: Option<&Value> = None;
            let mut audio_stream: Option<&Value> = None;

            if let Some(streams) = streams {
                for stream in streams {
                    let codec_type = stream.get("codec_type").and_then(|c| c.as_str());
                    match codec_type {
                        Some("video") if video_stream.is_none() => video_stream = Some(stream),
                        Some("audio") if audio_stream.is_none() => audio_stream = Some(stream),
                        _ => {}
                    }
                }
            }

            if let Some(vs) = video_stream {
                let codec_name = vs.get("codec_name")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                let nb_frames = vs.get("nb_frames")
                    .and_then(|n| n.as_str())
                    .and_then(|s| s.parse::<i64>().ok());
                let duration = format_info
                    .and_then(|f| f.get("duration"))
                    .and_then(|d| d.as_str())
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0);

                result.width = vs.get("width").and_then(|w| w.as_i64()).map(|w| w as i32);
                result.height = vs.get("height").and_then(|h| h.as_i64()).map(|h| h as i32);
                result.codec = Some(codec_name.clone());
                result.codec_long_name = vs.get("codec_long_name")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string());
                result.method = "ffprobe".to_string();

                // 判断类型
                if let Some(frames) = nb_frames {
                    if frames == 1 {
                        result.file_type = "image".to_string();
                        result.duration = 0.0;
                    } else if frames > 1 {
                        result.file_type = if audio_stream.is_some() {
                            "video".to_string()
                        } else {
                            "animated_image".to_string()
                        };
                        result.duration = duration;
                    }
                } else if VIDEO_CODECS.iter().any(|c| codec_name.contains(c)) {
                    result.file_type = "video".to_string();
                    result.duration = duration;
                } else if IMAGE_CODECS.iter().any(|c| codec_name.contains(c)) {
                    if codec_name == "gif" {
                        if duration > 0.1 {
                            result.file_type = "animated_image".to_string();
                            result.duration = duration;
                        } else {
                            result.file_type = "image".to_string();
                            result.duration = 0.0;
                        }
                    } else if codec_name == "mjpeg" {
                        if duration <= 0.1 {
                            result.file_type = "image".to_string();
                            result.duration = 0.0;
                        } else {
                            result.file_type = "video".to_string();
                            result.duration = duration;
                        }
                    } else if codec_name == "webp" {
                        if duration > 0.1 {
                            result.file_type = "animated_image".to_string();
                            result.duration = duration;
                        } else {
                            result.file_type = "image".to_string();
                            result.duration = 0.0;
                        }
                    } else {
                        result.file_type = "image".to_string();
                        result.duration = 0.0;
                    }
                } else if duration > 1.0 {
                    result.file_type = "video".to_string();
                    result.duration = duration;
                }
            } else if audio_stream.is_some() {
                result.file_type = "audio".to_string();
                if let Some(fi) = format_info {
                    result.duration = fi.get("duration")
                        .and_then(|d| d.as_str())
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0.0);
                }
            }
        }
    }

    // Layer 3: 兜底
    if result.file_type == "unknown" {
        result.file_type = "binary".to_string();
        result.method = "fallback".to_string();
    }

    result
}

// ==================== 文件夹统计 ====================

fn get_folder_size_recursive(path: &Path) -> u64 {
    let mut total: u64 = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_file() {
                    total += metadata.len();
                } else if metadata.is_dir() {
                    total += get_folder_size_recursive(&entry.path());
                }
            }
        }
    }
    total
}

fn get_folder_info(folder_path: &str, request_id: i64) -> FolderInfoResult {
    let path = Path::new(folder_path);
    let mut result = FolderInfoResult {
        id: request_id,
        ..Default::default()
    };

    if !path.exists() {
        result.error = Some("not_found".to_string());
        return result;
    }

    let mut ext_stats: HashMap<String, u32> = HashMap::new();
    let mut total_size: u64 = 0;
    let mut file_count: u32 = 0;

    // 遍历根目录
    if let Ok(entries) = fs::read_dir(path) {
        let mut subdirs: Vec<PathBuf> = Vec::new();

        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_file() {
                    total_size += metadata.len();
                    file_count += 1;

                    // 统计后缀
                    let ext = entry.path()
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_lowercase())
                        .unwrap_or_default();
                    *ext_stats.entry(ext).or_insert(0) += 1;
                } else if metadata.is_dir() {
                    subdirs.push(entry.path());
                }
            }
        }

        // 并行计算子目录大小 (简化版: 顺序计算)
        for subdir in subdirs {
            total_size += get_folder_size_recursive(&subdir);
        }
    }

    result.success = true;
    result.total_size = total_size;
    result.ext_stats = ext_stats;
    result.file_count_root = file_count;

    result
}

// ==================== Windows 剪贴板处理 ====================

#[cfg(target_os = "windows")]
mod clipboard_windows {
    use super::*;
    use std::ptr;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hwnd: *mut std::ffi::c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(format: u32) -> *mut std::ffi::c_void;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalLock(hmem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
        fn GlobalUnlock(hmem: *mut std::ffi::c_void) -> i32;
        fn GlobalSize(hmem: *mut std::ffi::c_void) -> usize;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(hdrop: *mut std::ffi::c_void, index: u32, buf: *mut u16, size: u32) -> u32;
    }

    const CF_UNICODETEXT: u32 = 13;
    const CF_HDROP: u32 = 15;
    const CF_DIB: u32 = 8;

    pub fn handle_clipboard(target_dir: &Path, request_id: i64) -> ClipboardResult {
        let mut result = ClipboardResult {
            id: request_id,
            result_type: "unknown".to_string(),
            path: None,
            text: None,
            files: None,
            ikges: None,
            error: None,
        };

        unsafe {
            if OpenClipboard(ptr::null_mut()) == 0 {
                result.error = Some("Cannot open clipboard".to_string());
                return result;
            }

            // 1. 检查文件 (CF_HDROP)
            if IsClipboardFormatAvailable(CF_HDROP) != 0 {
                let h_drop = GetClipboardData(CF_HDROP);
                if !h_drop.is_null() {
                    let count = DragQueryFileW(h_drop, 0xFFFFFFFF, ptr::null_mut(), 0);
                    let mut files: Vec<String> = Vec::new();
                    let mut folders: Vec<String> = Vec::new();

                    for i in 0..count {
                        let mut buf = [0u16; 1024];
                        DragQueryFileW(h_drop, i, buf.as_mut_ptr(), 1024);
                        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                        let path_str = OsString::from_wide(&buf[..len])
                            .to_string_lossy()
                            .to_string();

                        let path = Path::new(&path_str);
                        if path.exists() {
                            if path.is_dir() {
                                folders.push(path_str);
                            } else {
                                files.push(path_str);
                            }
                        }
                    }

                    CloseClipboard();

                    // 如果有文件夹，返回文件夹路径文本
                    if !folders.is_empty() {
                        result.result_type = "folder_text".to_string();
                        result.text = Some(folders.join("\n"));
                        return result;
                    }

                    // 处理文件
                    if !files.is_empty() {
                        let mut copied_files: Vec<String> = Vec::new();
                        let mut ikge_files: Vec<String> = Vec::new();

                        for file_path in &files {
                            let src = Path::new(file_path);
                            if let Some(ext_os) = src.extension() {
                                let ext = format!(".{}", ext_os.to_string_lossy().to_lowercase());
                                let is_img = is_image_ext(&ext);
                                let fname = if is_img {
                                    get_timestamp_filename(&ext)
                                } else {
                                    src.file_name()
                                        .map(|n| n.to_string_lossy().to_string())
                                        .unwrap_or_else(|| "unknown".to_string())
                                };

                                let dst = target_dir.join(&fname);
                                if fs::copy(src, &dst).is_ok() {
                                    let dst_str = dst.to_string_lossy().to_string();
                                    copied_files.push(dst_str.clone());
                                    if is_img {
                                        ikge_files.push(dst_str);
                                    }
                                }
                            } else {
                                // 无扩展名文件
                                let fname = src.file_name()
                                    .map(|n| n.to_string_lossy().to_string())
                                    .unwrap_or_else(|| "unknown".to_string());
                                let dst = target_dir.join(&fname);
                                if fs::copy(src, &dst).is_ok() {
                                    copied_files.push(dst.to_string_lossy().to_string());
                                }
                            }
                        }

                        if copied_files.len() == 1 {
                            let p = Path::new(&copied_files[0]);
                            if let Some(ext) = p.extension() {
                                let ext_str = format!(".{}", ext.to_string_lossy().to_lowercase());
                                if is_image_ext(&ext_str) {
                                    result.result_type = "ikge".to_string();
                                    result.path = Some(copied_files[0].clone());
                                    return result;
                                }
                            }
                        }

                        if !copied_files.is_empty() {
                            result.result_type = "file".to_string();
                            result.files = Some(copied_files);
                            result.ikges = Some(ikge_files);
                            return result;
                        }
                    }
                }
            }

            // 2. 检查 Unicode 文本
            if IsClipboardFormatAvailable(CF_UNICODETEXT) != 0 {
                let h_mem = GetClipboardData(CF_UNICODETEXT);
                if !h_mem.is_null() {
                    let ptr = GlobalLock(h_mem);
                    if !ptr.is_null() {
                        let mut len = 0;
                        let wstr = ptr as *const u16;
                        while *wstr.add(len) != 0 {
                            len += 1;
                        }
                        let slice = std::slice::from_raw_parts(wstr, len);
                        let text = OsString::from_wide(slice).to_string_lossy().to_string();
                        GlobalUnlock(h_mem);
                        CloseClipboard();

                        result.result_type = "text".to_string();
                        result.text = Some(text);
                        return result;
                    }
                }
            }

            // 3. 检查图片 (CF_DIB)
            if IsClipboardFormatAvailable(CF_DIB) != 0 {
                let h_mem = GetClipboardData(CF_DIB);
                if !h_mem.is_null() {
                    let ptr = GlobalLock(h_mem);
                    if !ptr.is_null() {
                        let size = GlobalSize(h_mem);
                        let data = std::slice::from_raw_parts(ptr as *const u8, size);

                        // 构建 BMP 文件
                        let mut bmp_data = Vec::with_capacity(14 + size);
                        bmp_data.extend_from_slice(b"BM");
                        let file_size = (14 + size) as u32;
                        bmp_data.extend_from_slice(&file_size.to_le_bytes());
                        bmp_data.extend_from_slice(&[0u8; 4]); // reserved
                        bmp_data.extend_from_slice(&54u32.to_le_bytes()); // offset
                        bmp_data.extend_from_slice(data);

                        GlobalUnlock(h_mem);
                        CloseClipboard();

                        // 保存为 PNG（先保存 BMP，然后尝试转换）
                        let fname = get_timestamp_filename(".png");
                        let bmp_path = target_dir.join(get_timestamp_filename(".bmp"));
                        let png_path = target_dir.join(&fname);

                        if fs::write(&bmp_path, &bmp_data).is_ok() {


                            // 尝试用 ffmpeg 转换为 PNG
                            let convert_result = Command::new("ffmpeg")
                                .args(["-y", "-i"])
                                .arg(&bmp_path)
                                .arg(&png_path)
                                .stdout(Stdio::null())
                                .stderr(Stdio::null())
                                .status();

                            // 清理 BMP 临时文件
                            let _ = fs::remove_file(&bmp_path);

                            if convert_result.is_ok() && png_path.exists() {
                                result.result_type = "ikge".to_string();
                                result.path = Some(png_path.to_string_lossy().to_string());
                                return result;
                            } else {
                                // 转换失败，直接保存 BMP
                                let bmp_fname = get_timestamp_filename(".bmp");
                                let final_bmp_path = target_dir.join(&bmp_fname);
                                if fs::write(&final_bmp_path, &bmp_data).is_ok() {
                                    result.result_type = "ikge".to_string();
                                    result.path = Some(final_bmp_path.to_string_lossy().to_string());
                                    return result;
                                }
                            }
                        }
                    }
                }
            }

            CloseClipboard();
        }

        result
    }
}

// ==================== macOS 剪贴板处理 ====================

#[cfg(target_os = "macos")]
mod clipboard_macos {
    use super::*;

    pub fn handle_clipboard(target_dir: &Path, request_id: i64) -> ClipboardResult {
        let mut result = ClipboardResult {
            id: request_id,
            result_type: "unknown".to_string(),
            path: None,
            text: None,
            files: None,
            ikges: None,
            error: None,
        };

        // 尝试获取图片 (pngpaste 或 pbpaste)
        let fname = get_timestamp_filename(".png");
        let dest = target_dir.join(&fname);

        // 尝试 pngpaste
        let pngpaste_result = Command::new("pngpaste")
            .arg(&dest)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        if pngpaste_result.is_ok() && dest.exists() && dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            result.result_type = "ikge".to_string();
            result.path = Some(dest.to_string_lossy().to_string());
            return result;
        }

        // 尝试 pbpaste
        let pbpaste_output = Command::new("pbpaste")
            .args(["-Prefer", "png"])
            .output();

        if let Ok(output) = pbpaste_output {
            if !output.stdout.is_empty() {
                // 检查是否是图片数据
                if output.stdout.starts_with(b"\x89PNG") {
                    if fs::write(&dest, &output.stdout).is_ok() {
                        result.result_type = "ikge".to_string();
                        result.path = Some(dest.to_string_lossy().to_string());
                        return result;
                    }
                } else {
                    // 可能是文本
                    if let Ok(text) = String::from_utf8(output.stdout) {
                        if !text.trim().is_empty() {
                            result.result_type = "text".to_string();
                            result.text = Some(text);
                            return result;
                        }
                    }
                }
            }
        }

        // 兜底：尝试纯文本
        let text_output = Command::new("pbpaste").output();
        if let Ok(output) = text_output {
            if let Ok(text) = String::from_utf8(output.stdout) {
                if !text.trim().is_empty() {
                    result.result_type = "text".to_string();
                    result.text = Some(text);
                    return result;
                }
            }
        }

        result
    }
}

// ==================== Linux 剪贴板处理 ====================

#[cfg(target_os = "linux")]
mod clipboard_linux {
    use super::*;

    pub fn handle_clipboard(target_dir: &Path, request_id: i64) -> ClipboardResult {
        let mut result = ClipboardResult {
            id: request_id,
            result_type: "unknown".to_string(),
            path: None,
            text: None,
            files: None,
            ikges: None,
            error: None,
        };

        // 尝试获取图片
        let fname = get_timestamp_filename(".png");
        let dest = target_dir.join(&fname);

        let xclip_output = Command::new("xclip")
            .args(["-selection", "clipboard", "-t", "image/png", "-o"])
            .output();

        if let Ok(output) = xclip_output {
            if !output.stdout.is_empty() && output.stdout.starts_with(b"\x89PNG") {
                if fs::write(&dest, &output.stdout).is_ok() {
                    result.result_type = "ikge".to_string();
                    result.path = Some(dest.to_string_lossy().to_string());
                    return result;
                }
            }
        }

        // 尝试文本
        let text_output = Command::new("xclip")
            .args(["-selection", "clipboard", "-o"])
            .output();

        if let Ok(output) = text_output {
            if let Ok(text) = String::from_utf8(output.stdout) {
                if !text.trim().is_empty() {
                    result.result_type = "text".to_string();
                    result.text = Some(text);
                    return result;
                }
            }
        }

        result
    }
}

// ==================== 统一剪贴板处理入口 ====================

fn handle_clipboard(target_dir_str: Option<&str>, request_id: i64) -> ClipboardResult {
    // 如果没有提供 target_dir_str，则使用文档同级的 qqq 文件夹
    let target_dir = target_dir_str
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("D:/view/p"));

    // 确保目录存在
    if let Err(e) = ensure_dir(&target_dir) {
        return ClipboardResult {
            id: request_id,
            result_type: "error".to_string(),
            error: Some(format!("Cannot create directory: {}", e)),
            path: None,
            text: None,
            files: None,
            ikges: None,
        };
    }

    #[cfg(target_os = "windows")]
    {
        clipboard_windows::handle_clipboard(&target_dir, request_id)
    }

    #[cfg(target_os = "macos")]
    {
        clipboard_macos::handle_clipboard(&target_dir, request_id)
    }

    #[cfg(target_os = "linux")]
    {
        clipboard_linux::handle_clipboard(&target_dir, request_id)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        ClipboardResult {
            id: request_id,
            result_type: "unknown".to_string(),
            error: Some("Unsupported platform".to_string()),
            path: None,
            text: None,
            files: None,
            ikges: None,
        }
    }
}

// ==================== Daemon 模式 ====================

fn daemon_mode() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let cmd: Result<CommandRequest, _> = serde_json::from_str(line);
        let request_id = cmd.as_ref().ok().and_then(|c| c.id).unwrap_or(0);

        let response: Value = match cmd {
            Ok(request) => {
                match request.action.as_str() {
                    "ping" => {
                        json!({
                            "_id": request_id,
                            "status": "alive"
                        })
                    }

                    "identify" => {
                        let path = request.path.unwrap_or_default();
                        let result = identify_file(&path, request_id);
                        serde_json::to_value(result).unwrap_or_else(|_| json!({"_id": request_id, "error": "serialize_error"}))
                    }

                    "folder_info" | "folder_size" => {
                        let path = request.path.unwrap_or_default();
                        let result = get_folder_info(&path, request_id);
                        serde_json::to_value(result).unwrap_or_else(|_| json!({"_id": request_id, "error": "serialize_error"}))
                    }

                    "clipboard" => {
                        let target_dir = request.target_dir.as_deref();
                        let result = handle_clipboard(target_dir, request_id);
                        serde_json::to_value(result).unwrap_or_else(|_| json!({"_id": request_id, "error": "serialize_error"}))
                    }

                    _ => {
                        json!({
                            "_id": request_id,
                            "error": format!("unknown action: {}", request.action)
                        })
                    }
                }
            }
            Err(e) => {
                json!({
                    "_id": 0,
                    "error": format!("JSON parse error: {}", e)
                })
            }
        };

        let output = serde_json::to_string(&response).unwrap_or_else(|_| r#"{"error":"serialize_error"}"#.to_string());
        let _ = writeln!(stdout, "{}", output);
        let _ = stdout.flush();
    }
}

// ==================== CLI 入口 ====================

fn print_usage() {
    eprintln!("Usage:");
    eprintln!("  q --daemon           Run in daemon mode (stdin/stdout JSON)");
    eprintln!("  q identify <path>    Identify a file");
    eprintln!("  q folder_info <path> Get folder info");
    eprintln!("  q clipboard [dir]    Handle clipboard");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        // 默认：剪贴板处理
        let result = handle_clipboard(None, 0);
        println!("{}", serde_json::to_string(&result).unwrap_or_default());
        return;
    }

    match args[1].as_str() {
        "--daemon" => {
            daemon_mode();
        }

        "identify" => {
            if args.len() < 3 {
                eprintln!("Error: Missing file path");
                std::process::exit(1);
            }
            let result = identify_file(&args[2], 0);
            println!("{}", serde_json::to_string(&result).unwrap_or_default());
        }

        "folder_info" | "get_size" => {
            if args.len() < 3 {
                eprintln!("Error: Missing folder path");
                std::process::exit(1);
            }
            let result = get_folder_info(&args[2], 0);
            println!("{}", serde_json::to_string(&result).unwrap_or_default());
        }

        "clipboard" => {
            let target_dir = args.get(2).map(|s| s.as_str());
            let result = handle_clipboard(target_dir, 0);
            println!("{}", serde_json::to_string(&result).unwrap_or_default());
        }

        "--help" | "-h" => {
            print_usage();
        }

        _ => {
            eprintln!("Unknown command: {}", args[1]);
            print_usage();
            std::process::exit(1);
        }
    }
}
