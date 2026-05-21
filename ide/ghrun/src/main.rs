// main.rs — ghrun: qqq IDE component manager & gaea goods installer
//
// Protocol: all output is JSON lines to stdout.
//   {"event":"start","component":"ffmpeg","version":"7.1"}
//   {"event":"progress","downloaded":1048576,"total":52428800,"percent":2}
//   {"event":"done","component":"ffmpeg","path":"/path/to/ffmpeg.exe"}
//   {"event":"error","msg":"..."}
//
// The Node.js extension spawns ghrun and parses stdout line-by-line.
// stderr is for human-readable debug info only.

use clap::{Parser, Subcommand};

mod ctx;
mod ensure;
mod install;
mod manifest;

use ctx::Ctx;

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

#[derive(Parser)]
#[command(name = "ghrun", version, about = "qqq IDE component manager")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Initialize QDIR directory structure
    Init,

    /// Ensure a component is installed (idempotent)
    /// Examples: ghrun ensure ffmpeg | ghrun ensure python yt-dlp
    Ensure {
        /// Component name(s): ffmpeg, python, yt-dlp, git
        #[arg(required = true)]
        components: Vec<String>,
    },

    /// Install a gaea good from its gaea.json URL
    Install {
        /// URL to gaea.json manifest
        url: String,
    },

    /// Upgrade all installed components to latest versions
    Upgrade,

    /// List installed components and goods
    List,

    /// Print QDIR path info (useful for debugging)
    Info,
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let cli = Cli::parse();
    let ctx = Ctx::detect();

    let result = match cli.cmd {
        Cmd::Init => cmd_init(&ctx),
        Cmd::Ensure { components } => cmd_ensure(&ctx, &components),
        Cmd::Install { url } => cmd_install(&ctx, &url),
        Cmd::Upgrade => cmd_upgrade(&ctx),
        Cmd::List => { install::list_goods(&ctx); Ok(()) },
        Cmd::Info => cmd_info(&ctx),
    };

    if let Err(e) = result {
        let msg = serde_json::json!({"event":"error","msg": e});
        eprintln!("{}", msg);
        println!("{}", msg);
        std::process::exit(1);
    }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

fn cmd_init(ctx: &Ctx) -> Result<(), String> {
    ctx.init_dirs().map_err(|e| e.to_string())?;
    // Write portable marker if not present
    let marker = ctx.f.join(".qqq-portable");
    if !marker.exists() {
        std::fs::write(&marker, format!("ghrun init {}", chrono_now()))
            .map_err(|e| e.to_string())?;
    }
    println!("{}", serde_json::json!({"event":"init_done","qdir": ctx.qdir.to_string_lossy().to_string()}));
    Ok(())
}

fn cmd_ensure(ctx: &Ctx, names: &[String]) -> Result<(), String> {
    ctx.init_dirs().map_err(|e| e.to_string())?;
    let refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
    ensure::ensure_all(ctx, &refs)
}

fn cmd_install(ctx: &Ctx, url: &str) -> Result<(), String> {
    ctx.init_dirs().map_err(|e| e.to_string())?;
    install::install_good_from_url(ctx, url)
}

fn cmd_upgrade(ctx: &Ctx) -> Result<(), String> {
    // For each component that has a .version file: re-ensure it.
    // ensure_component will skip if version matches, re-download if bumped.
    let components = ["ffmpeg", "python", "yt-dlp", "git"];
    for name in &components {
        let ver_file = ctx.component_dir(name).join(".version");
        if ver_file.exists() {
            if let Err(e) = ensure::ensure_component(ctx, name) {
                eprintln!("upgrade {}: {}", name, e);
            }
        }
    }
    println!("{}", serde_json::json!({"event":"upgrade_done"}));
    Ok(())
}

fn cmd_info(ctx: &Ctx) -> Result<(), String> {
    println!("{}", serde_json::json!({
        "event":      "info",
        "qdir":       ctx.qdir.to_string_lossy().to_string(),
        "f":          ctx.f.to_string_lossy().to_string(),
        "components": ctx.components.to_string_lossy().to_string(),
        "goods":      ctx.goods.to_string_lossy().to_string(),
        "builtin":    ctx.extensions.to_string_lossy().to_string(),
        "platform":   manifest::current_platform(),
    }));
    Ok(())
}

fn chrono_now() -> String {
    // Simple timestamp without chrono dep overhead
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    format!("unix={}", secs)
}
