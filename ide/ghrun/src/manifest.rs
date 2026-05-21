// manifest.rs — component and goods manifest definitions.
// For MVP: manifests are hardcoded here.
// Future: fetched from https://cdn.gh555.com/ghrun/manifest.json and cached locally.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformEntry {
    pub url:        String,
    /// hex SHA-256 of the downloaded archive
    pub sha256:     String,
    /// sub-directory name to extract into (inside components/<name>/ or goods/<id>/)
    pub extract_to: Option<String>,
    /// relative path to the main executable (used to set QDIR_<NAME> etc.)
    pub bin:        Option<String>,
    /// "zip" | "tar.gz" | "binary" (raw file, no archive)
    pub kind:       String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentManifest {
    pub name:        String,
    pub version:     String,
    pub platforms:   HashMap<String, PlatformEntry>,
}

// ---------------------------------------------------------------------------
// Hardcoded component registry (MVP)
// ---------------------------------------------------------------------------

/// Detect current platform key: "win32-x64" | "linux-x64" | "darwin-x64" | "darwin-arm64"
pub fn current_platform() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]   { "win32-x64"    }
    #[cfg(all(target_os = "linux",   target_arch = "x86_64"))]   { "linux-x64"    }
    #[cfg(all(target_os = "macos",   target_arch = "x86_64"))]   { "darwin-x64"   }
    #[cfg(all(target_os = "macos",   target_arch = "aarch64"))]  { "darwin-arm64" }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux",   target_arch = "x86_64"),
        all(target_os = "macos",   target_arch = "x86_64"),
        all(target_os = "macos",   target_arch = "aarch64"),
    )))] { "unknown" }
}

pub fn builtin_components() -> Vec<ComponentManifest> {
    vec![
        // ------------------------------------------------------------------ ffmpeg
        ComponentManifest {
            name:    "ffmpeg".into(),
            version: "7.1".into(),
            platforms: [
                ("win32-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/ffmpeg/7.1/win32-x64.zip".into(),
                    sha256:     "".into(),   // filled by deploy script
                    extract_to: Some("ffmpeg".into()),
                    bin:        Some("ffmpeg.exe".into()),
                    kind:       "zip".into(),
                }),
                ("linux-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/ffmpeg/7.1/linux-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("ffmpeg".into()),
                    bin:        Some("ffmpeg".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-arm64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/ffmpeg/7.1/darwin-arm64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("ffmpeg".into()),
                    bin:        Some("ffmpeg".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/ffmpeg/7.1/darwin-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("ffmpeg".into()),
                    bin:        Some("ffmpeg".into()),
                    kind:       "tar.gz".into(),
                }),
            ].into(),
        },

        // ------------------------------------------------------------------ yt-dlp
        ComponentManifest {
            name:    "yt-dlp".into(),
            version: "2025.05.01".into(),
            platforms: [
                ("win32-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/yt-dlp/2025.05.01/yt-dlp.exe".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("yt-dlp.exe".into()),
                    kind:       "binary".into(),
                }),
                ("linux-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/yt-dlp/2025.05.01/yt-dlp_linux".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("yt-dlp".into()),
                    kind:       "binary".into(),
                }),
                ("darwin-arm64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/yt-dlp/2025.05.01/yt-dlp_macos".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("yt-dlp".into()),
                    kind:       "binary".into(),
                }),
                ("darwin-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/yt-dlp/2025.05.01/yt-dlp_macos".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("yt-dlp".into()),
                    kind:       "binary".into(),
                }),
            ].into(),
        },

        // ------------------------------------------------------------------ python
        ComponentManifest {
            name:    "python".into(),
            version: "3.12.3".into(),
            platforms: [
                ("win32-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/python/3.12.3/win32-x64.zip".into(),
                    sha256:     "".into(),
                    extract_to: Some("python".into()),
                    bin:        Some("python.exe".into()),
                    kind:       "zip".into(),
                }),
                ("linux-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/python/3.12.3/linux-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("python".into()),
                    bin:        Some("bin/python3".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-arm64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/python/3.12.3/darwin-arm64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("python".into()),
                    bin:        Some("bin/python3".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/python/3.12.3/darwin-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("python".into()),
                    bin:        Some("bin/python3".into()),
                    kind:       "tar.gz".into(),
                }),
            ].into(),
        },

        // ------------------------------------------------------------------ git (Windows only for now)
        ComponentManifest {
            name:    "git".into(),
            version: "2.46.0".into(),
            platforms: [
                ("win32-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/git/2.46.0/win32-x64.zip".into(),
                    sha256:     "".into(),
                    extract_to: Some("git".into()),
                    bin:        Some("bin/git.exe".into()),
                    kind:       "zip".into(),
                }),
            ].into(),
        },
    ]
}

pub fn find_component(name: &str) -> Option<ComponentManifest> {
    builtin_components().into_iter().find(|c| c.name == name)
}
