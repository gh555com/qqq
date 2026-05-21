// ensure.rs — download, verify (SHA-256), extract component archives.
// All output is JSON lines to stdout so the Node.js extension can parse progress.

use crate::{ctx::Ctx, manifest::{ComponentManifest, PlatformEntry, current_platform, find_component}};
use sha2::{Digest, Sha256};
use std::{fs, io::{self, Read, Write}, path::{Path, PathBuf}};

// ---------------------------------------------------------------------------
// Progress events (JSON lines → stdout)
// ---------------------------------------------------------------------------

fn emit(obj: serde_json::Value) {
    println!("{}", obj);
    // flush — Node.js spawns ghrun with stdio piped
    let _ = io::stdout().flush();
}

macro_rules! ev {
    ($($k:expr => $v:expr),*) => {
        serde_json::json!({ $($k: $v),* })
    };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// `ghrun ensure <name>` — idempotent, safe to call multiple times.
pub fn ensure_component(ctx: &Ctx, name: &str) -> Result<(), String> {
    let manifest = find_component(name)
        .ok_or_else(|| format!("unknown component: {}", name))?;

    let platform = current_platform();
    let entry = manifest.platforms.get(platform)
        .ok_or_else(|| format!("no entry for platform: {}", platform))?;

    let dest = ctx.component_dir(name);

    // Already installed? Check version marker.
    let version_file = dest.join(".version");
    if version_file.exists() {
        let installed = fs::read_to_string(&version_file).unwrap_or_default();
        if installed.trim() == manifest.version {
            emit(ev!("event" => "already_installed", "component" => name, "version" => manifest.version));
            return Ok(());
        }
    }

    emit(ev!("event" => "start", "component" => name, "version" => manifest.version, "platform" => platform));

    // Create dest + tmp
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let tmp_dir = ctx.tmp.join(format!("{}-{}", name, &manifest.version));
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let archive_path = download(ctx, entry, name)?;

    if !entry.sha256.is_empty() {
        verify_sha256(&archive_path, &entry.sha256)?;
    } else {
        emit(ev!("event" => "verify_skip", "reason" => "no sha256 in manifest"));
    }

    extract(entry, &archive_path, &dest, name)?;

    // On unix: make bin executable
    #[cfg(unix)]
    if let Some(bin) = &entry.bin {
        let bin_path = dest.join(bin);
        if bin_path.exists() {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&bin_path, fs::Permissions::from_mode(0o755));
        }
    }

    // Write version marker
    fs::write(&version_file, &manifest.version).map_err(|e| e.to_string())?;

    // Announce final bin path
    let bin_path = entry.bin.as_ref().map(|b| dest.join(b));
    emit(ev!("event" => "done", "component" => name, "version" => manifest.version,
             "path" => bin_path.as_ref().map(|p| p.to_string_lossy().to_string())));

    // Clean up tmp archive
    let _ = fs::remove_file(&archive_path);

    Ok(())
}

/// Ensure multiple components in order.
pub fn ensure_all(ctx: &Ctx, names: &[&str]) -> Result<(), String> {
    for name in names {
        ensure_component(ctx, name)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

fn download(ctx: &Ctx, entry: &PlatformEntry, name: &str) -> Result<PathBuf, String> {
    let url = &entry.url;
    let ext = if url.ends_with(".tar.gz") { ".tar.gz" }
              else if url.ends_with(".zip") { ".zip" }
              else { "" };
    let archive_path = ctx.tmp.join(format!("{}{}", name, ext));

    emit(ev!("event" => "download_start", "url" => url, "dest" => archive_path.to_string_lossy().to_string()));

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let mut response = client.get(url)
        .send()
        .map_err(|e| format!("HTTP error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("download failed: HTTP {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    let mut file = fs::File::create(&archive_path).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut buf = vec![0u8; 65536];

    loop {
        let n = response.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        if total > 0 {
            let pct = (downloaded * 100 / total) as u8;
            // emit every 5%
            if pct % 5 == 0 {
                emit(ev!("event" => "progress", "downloaded" => downloaded, "total" => total, "percent" => pct));
            }
        }
    }

    emit(ev!("event" => "download_done", "bytes" => downloaded));
    Ok(archive_path)
}

// ---------------------------------------------------------------------------
// SHA-256 verify
// ---------------------------------------------------------------------------

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    let got = hex::encode(hasher.finalize());
    if got.to_lowercase() != expected.to_lowercase() {
        return Err(format!("SHA-256 mismatch: got {} expected {}", got, expected));
    }
    emit(ev!("event" => "verify_ok", "sha256" => got));
    Ok(())
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

fn extract(entry: &PlatformEntry, archive: &Path, dest: &Path, name: &str) -> Result<(), String> {
    match entry.kind.as_str() {
        "binary" => {
            // Raw binary — copy to dest/<bin>
            let bin_name = entry.bin.as_deref().unwrap_or(name);
            let out = dest.join(bin_name);
            fs::copy(archive, &out).map_err(|e| e.to_string())?;
            emit(ev!("event" => "extract_done", "path" => out.to_string_lossy().to_string()));
        }
        "zip" => {
            let file = fs::File::open(archive).map_err(|e| e.to_string())?;
            let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
            let strip = detect_common_prefix_zip(&mut zip);
            for i in 0..zip.len() {
                let mut zf = zip.by_index(i).map_err(|e| e.to_string())?;
                let raw_name = zf.name().to_string();
                let rel = strip_prefix(&raw_name, &strip);
                if rel.is_empty() || rel.ends_with('/') { continue; }
                let out = dest.join(rel);
                if let Some(p) = out.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
                let mut outf = fs::File::create(&out).map_err(|e| e.to_string())?;
                io::copy(&mut zf, &mut outf).map_err(|e| e.to_string())?;
            }
            emit(ev!("event" => "extract_done", "format" => "zip", "dest" => dest.to_string_lossy().to_string()));
        }
        "tar.gz" => {
            let file = fs::File::open(archive).map_err(|e| e.to_string())?;
            let gz = flate2::read::GzDecoder::new(file);
            let mut tar = tar::Archive::new(gz);
            tar.set_preserve_permissions(true);
            // Determine strip prefix from first entry
            let file2 = fs::File::open(archive).map_err(|e| e.to_string())?;
            let gz2 = flate2::read::GzDecoder::new(file2);
            let mut tar2 = tar::Archive::new(gz2);
            let strip = detect_common_prefix_tar(&mut tar2);
            // Re-open for actual extraction
            let file3 = fs::File::open(archive).map_err(|e| e.to_string())?;
            let gz3 = flate2::read::GzDecoder::new(file3);
            let mut tar3 = tar::Archive::new(gz3);
            for entry_res in tar3.entries().map_err(|e| e.to_string())? {
                let mut entry = entry_res.map_err(|e| e.to_string())?;
                let raw_path = entry.path().map_err(|e| e.to_string())?.to_string_lossy().to_string();
                let rel = strip_prefix(&raw_path, &strip);
                if rel.is_empty() || rel.ends_with('/') { continue; }
                let out = dest.join(&rel);
                if let Some(p) = out.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
                entry.unpack(&out).map_err(|e| e.to_string())?;
            }
            emit(ev!("event" => "extract_done", "format" => "tar.gz", "dest" => dest.to_string_lossy().to_string()));
        }
        other => return Err(format!("unknown archive kind: {}", other)),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers: detect common archive prefix to strip
// ---------------------------------------------------------------------------

fn detect_common_prefix_zip(zip: &mut zip::ZipArchive<fs::File>) -> String {
    if zip.len() == 0 { return String::new(); }
    let first = zip.by_index(0).ok().map(|f| f.name().to_string()).unwrap_or_default();
    if let Some(idx) = first.find('/') { first[..=idx].to_string() } else { String::new() }
}

fn detect_common_prefix_tar<R: Read>(tar: &mut tar::Archive<R>) -> String {
    for entry in tar.entries().into_iter().flatten().flatten() {
        if let Ok(p) = entry.path() {
            let s = p.to_string_lossy().to_string();
            if let Some(idx) = s.find('/') { return s[..=idx].to_string(); }
        }
        break;
    }
    String::new()
}

fn strip_prefix<'a>(path: &'a str, prefix: &str) -> &'a str {
    if !prefix.is_empty() && path.starts_with(prefix) {
        &path[prefix.len()..]
    } else {
        path
    }
}
