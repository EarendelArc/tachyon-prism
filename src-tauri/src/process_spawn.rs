use std::io;
use std::process::{Child, Command};
#[cfg(test)]
use std::process::{ExitStatus, Output};

#[cfg(target_os = "macos")]
use std::sync::{Mutex, MutexGuard};

#[cfg(target_os = "macos")]
static FD_SPAWN_LOCK: Mutex<()> = Mutex::new(());

#[cfg(target_os = "macos")]
pub(crate) struct FdSpawnGuard {
    _guard: MutexGuard<'static, ()>,
}

#[cfg(not(target_os = "macos"))]
pub(crate) struct FdSpawnGuard;

pub(crate) fn fd_spawn_guard() -> io::Result<FdSpawnGuard> {
    #[cfg(target_os = "macos")]
    {
        return FD_SPAWN_LOCK
            .lock()
            .map(|guard| FdSpawnGuard { _guard: guard })
            .map_err(|_| io::Error::other("process FD/spawn lock poisoned"));
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(FdSpawnGuard)
    }
}

pub(crate) fn spawn(command: &mut Command) -> io::Result<Child> {
    let _guard = fd_spawn_guard()?;
    command.spawn()
}

#[cfg(test)]
pub(crate) fn output(command: &mut Command) -> io::Result<Output> {
    let _guard = fd_spawn_guard()?;
    command.output()
}

#[cfg(test)]
pub(crate) fn status(command: &mut Command) -> io::Result<ExitStatus> {
    let _guard = fd_spawn_guard()?;
    command.status()
}
