// watchdog.rs — ghrun watchdog process (~500 KB compiled)
// Responsibility: monitor ghrun.exe, respawn if dead.
// Pure std — zero external dependencies for minimal binary size.
//
// Usage: watchdog.exe <ghrun_path> [ghrun_args...]
// The ghrun_path should be absolute or relative to watchdog.exe location.

use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const HEARTBEAT: Duration = Duration::from_secs(5);
const DELAY: Duration = Duration::from_secs(1);
const MAX_RAPID: u32 = 10;   // max rapid restarts before backing off
const BACKOFF: Duration = Duration::from_secs(30);

fn ts() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn log(lf: &Path, msg: &str) {
    let line = format!("[watchdog {}] {}\n", ts(), msg);
    eprint!("{}", line);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(lf) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn log_path(ghrun: &Path) -> PathBuf {
    let dir = ghrun.parent().unwrap_or(Path::new(".")).join("logs");
    let _ = fs::create_dir_all(&dir);
    dir.join("watchdog.log")
}

fn try_spawn(ghrun: &Path, args: &[String]) -> Option<Child> {
    Command::new(ghrun).args(args).spawn().ok()
}

fn main() {
    let argv: Vec<String> = env::args().collect();
    if argv.len() < 2 {
        eprintln!("Usage: watchdog <ghrun_path> [ghrun_args...]");
        std::process::exit(1);
    }
    let ghrun = PathBuf::from(&argv[1]);
    let args: Vec<String> = argv[2..].to_vec();
    let lf = log_path(&ghrun);

    log(&lf, &format!("start, target={}", ghrun.display()));

    let mut child = try_spawn(&ghrun, &args);
    let mut rapid = 0u32;

    loop {
        thread::sleep(HEARTBEAT);

        let alive = match &mut child {
            Some(c) => match c.try_wait() {
                Ok(None) => true,         // still running
                Ok(Some(st)) => {
                    log(&lf, &format!("ghrun exited: {}", st));
                    false
                }
                Err(e) => {
                    log(&lf, &format!("try_wait err: {}", e));
                    false
                }
            },
            None => false,
        };

        if !alive {
            rapid += 1;
            let wait = if rapid > MAX_RAPID { BACKOFF } else { DELAY };
            log(&lf, &format!("respawn #{} in {}s", rapid, wait.as_secs()));
            thread::sleep(wait);
            child = try_spawn(&ghrun, &args);
            if child.is_some() && rapid > MAX_RAPID {
                rapid = 0;  // reset after successful backoff spawn
            }
        } else {
            rapid = 0;
        }
    }
}
