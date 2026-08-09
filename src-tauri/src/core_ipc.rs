use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::process::ExitStatus;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use zeroize::Zeroizing;

const TOKEN_ENV: &str = "TACHYON_IPC_TOKEN_HANDLE";
const TOKEN_BYTES: usize = 32;
const TOKEN_ENCODED_BYTES: usize = 43;
const TOKEN_MESSAGE_BYTES: usize = TOKEN_ENCODED_BYTES + 1;
const TOKEN_READ_LIMIT: u64 = (TOKEN_MESSAGE_BYTES + 1) as u64;
#[cfg(unix)]
const UNIX_TOKEN_FD: i32 = 198;
#[cfg(unix)]
const UNIX_WATCHDOG_FD: i32 = 199;
#[cfg(unix)]
const WATCHDOG_NORMAL_EXIT: u8 = b'N';

#[cfg(unix)]
#[derive(Clone, Copy, Default)]
enum CloexecPipeFault {
    #[default]
    None,
    #[cfg(all(test, target_os = "macos"))]
    FirstFcntl,
    #[cfg(all(test, target_os = "macos"))]
    SecondFcntl,
}

#[derive(Default)]
struct SpawnOptions {
    child_env: Vec<(OsString, OsString)>,
    #[cfg(all(test, unix))]
    watchdog_failure: Option<UnixWatchdogFailure>,
}

#[cfg(all(test, unix))]
#[derive(Clone, Copy)]
enum UnixWatchdogFailure {
    Pipe,
    CurrentExe,
    Spawn,
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct UnixProcessIdentity {
    pid: i32,
    pgid: i32,
    started: u128,
}

#[cfg(unix)]
fn create_cloexec_pipe(fault: CloexecPipeFault) -> io::Result<[std::os::fd::OwnedFd; 2]> {
    use std::os::fd::{FromRawFd, OwnedFd};

    let mut fds = [-1; 2];
    #[cfg(target_os = "linux")]
    {
        let _ = fault;
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
        return Ok(unsafe { [OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])] });
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;

        let _guard = crate::process_spawn::fd_spawn_guard()?;
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let owned = unsafe { [OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])] };
        for (index, fd) in owned.iter().enumerate() {
            #[cfg(test)]
            if matches!(
                (fault, index),
                (CloexecPipeFault::FirstFcntl, 0) | (CloexecPipeFault::SecondFcntl, 1)
            ) {
                return Err(io::Error::other("injected Darwin fcntl failure"));
            }
            let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
            if flags < 0
                || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) }
                    < 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        return Ok(owned);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = fault;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "secure CLOEXEC pipes are unsupported on this Unix platform",
        ))
    }
}

pub(crate) struct SpawnedCore {
    pub(crate) child: CoreChild,
    pub(crate) stdout: Option<Box<dyn Read + Send>>,
    pub(crate) stderr: Option<Box<dyn Read + Send>>,
}

pub(crate) struct CoreChild {
    platform: PlatformChild,
    token: Zeroizing<String>,
}

impl CoreChild {
    pub(crate) fn id(&self) -> u32 {
        self.platform.id()
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.platform.try_wait()
    }

    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        self.platform.wait()
    }

    pub(crate) fn kill(&mut self) -> io::Result<()> {
        self.platform.kill()
    }

    #[cfg(unix)]
    pub(crate) fn request_graceful_stop(&self) -> io::Result<()> {
        self.platform.request_graceful_stop()
    }

    pub(crate) fn bearer(&self) -> &str {
        self.token.as_str()
    }
}

pub(crate) fn spawn(
    binary: &Path,
    args: &[&OsStr],
    current_dir: Option<&Path>,
    timeout: Duration,
) -> Result<SpawnedCore, String> {
    spawn_with_options(binary, args, current_dir, timeout, SpawnOptions::default())
}

fn spawn_with_options(
    binary: &Path,
    args: &[&OsStr],
    current_dir: Option<&Path>,
    timeout: Duration,
    options: SpawnOptions,
) -> Result<SpawnedCore, String> {
    let (reader, pipe) = platform::create_token_pipe()
        .map_err(|_| "create secure Core IPC token handoff".to_string())?;
    let mut spawned = platform::spawn_core(binary, args, current_dir, pipe, options)
        .map_err(|_| "start Tachyon Core secure child".to_string())?;
    let token = match read_token(reader, timeout) {
        Ok(token) => token,
        Err(error) => {
            let _ = spawned.child.kill();
            let _ = spawned.child.wait();
            return Err(error);
        }
    };
    if let Some(status) = spawned
        .child
        .try_wait()
        .map_err(|_| "check Tachyon Core after IPC token handoff".to_string())?
    {
        return Err(format!(
            "Tachyon Core exited during secure IPC token handoff ({status})"
        ));
    }
    Ok(SpawnedCore {
        child: CoreChild {
            platform: spawned.child,
            token,
        },
        stdout: spawned.stdout,
        stderr: spawned.stderr,
    })
}

fn read_token(reader: File, timeout: Duration) -> Result<Zeroizing<String>, String> {
    let (tx, rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("tachyon-core-ipc-token-reader".to_string())
        .spawn(move || {
            let mut bytes = Zeroizing::new(Vec::with_capacity(TOKEN_MESSAGE_BYTES + 1));
            let result = reader
                .take(TOKEN_READ_LIMIT)
                .read_to_end(&mut bytes)
                .map(|_| bytes);
            let _ = tx.send(result);
        })
        .map_err(|_| "start secure Core IPC token reader".to_string())?;
    let bytes = rx
        .recv_timeout(timeout)
        .map_err(|_| "Tachyon Core IPC token handoff timed out".to_string())?
        .map_err(|_| "read Tachyon Core IPC token handoff".to_string())?;
    validate_token_message(bytes.as_slice())
}

fn validate_token_message(bytes: &[u8]) -> Result<Zeroizing<String>, String> {
    if bytes.len() != TOKEN_MESSAGE_BYTES || bytes[TOKEN_ENCODED_BYTES] != b'\n' {
        return Err("Tachyon Core IPC token handoff has an invalid length".to_string());
    }
    if !bytes[..TOKEN_ENCODED_BYTES]
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Tachyon Core IPC token handoff is not base64url".to_string());
    }
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(&bytes[..TOKEN_ENCODED_BYTES])
            .map_err(|_| "Tachyon Core IPC token handoff is not base64url".to_string())?,
    );
    if decoded.len() != TOKEN_BYTES {
        return Err("Tachyon Core IPC token handoff is not 256-bit".to_string());
    }
    let mut encoded = Zeroizing::new(String::with_capacity(TOKEN_ENCODED_BYTES));
    for byte in &bytes[..TOKEN_ENCODED_BYTES] {
        encoded.push(char::from(*byte));
    }
    Ok(encoded)
}

enum PlatformChild {
    #[cfg(unix)]
    Unix(platform::UnixChild),
    #[cfg(target_os = "windows")]
    Windows(platform::WindowsChild),
}

impl PlatformChild {
    fn id(&self) -> u32 {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.id(),
            #[cfg(target_os = "windows")]
            Self::Windows(child) => child.id(),
        }
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.try_wait(),
            #[cfg(target_os = "windows")]
            Self::Windows(child) => child.try_wait(),
        }
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.wait(),
            #[cfg(target_os = "windows")]
            Self::Windows(child) => child.wait(),
        }
    }

    fn kill(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.kill(),
            #[cfg(target_os = "windows")]
            Self::Windows(child) => child.kill(),
        }
    }

    #[cfg(unix)]
    fn request_graceful_stop(&self) -> io::Result<()> {
        let Self::Unix(child) = self;
        let result = unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM) };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

struct PlatformSpawn {
    child: PlatformChild,
    stdout: Option<Box<dyn Read + Send>>,
    stderr: Option<Box<dyn Read + Send>>,
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::io::Write;
    use std::os::fd::{AsRawFd, IntoRawFd, RawFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};

    pub(super) struct UnixChild {
        child: Child,
        watchdog: Option<Child>,
        watchdog_control: Option<File>,
    }

    impl UnixChild {
        pub(super) fn id(&self) -> u32 {
            self.child.id()
        }

        pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            let status = self.child.try_wait()?;
            if status.is_some() {
                self.finish_watchdog();
            }
            Ok(status)
        }

        pub(super) fn wait(&mut self) -> io::Result<ExitStatus> {
            let status = self.child.wait()?;
            self.finish_watchdog();
            Ok(status)
        }

        pub(super) fn kill(&mut self) -> io::Result<()> {
            if self.child.try_wait()?.is_some() {
                self.finish_watchdog();
                return Ok(());
            }
            let result = unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL) };
            if result == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }

        fn finish_watchdog(&mut self) {
            if let Some(mut control) = self.watchdog_control.take() {
                let _ = control.write_all(&[WATCHDOG_NORMAL_EXIT]);
                let _ = control.flush();
            }
            if let Some(mut watchdog) = self.watchdog.take() {
                let _ = watchdog.wait();
            }
        }
    }

    impl Drop for UnixChild {
        fn drop(&mut self) {
            if self.child.try_wait().ok().flatten().is_none() {
                let _ = unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL) };
                let _ = self.child.wait();
            }
            self.finish_watchdog();
        }
    }

    pub(super) struct TokenPipe {
        write_fd: RawFd,
    }

    impl Drop for TokenPipe {
        fn drop(&mut self) {
            if self.write_fd >= 0 {
                unsafe { libc::close(self.write_fd) };
            }
        }
    }

    pub(super) fn create_token_pipe() -> io::Result<(File, TokenPipe)> {
        let [reader, writer] = create_cloexec_pipe(CloexecPipeFault::None)?;
        Ok((
            File::from(reader),
            TokenPipe {
                write_fd: writer.into_raw_fd(),
            },
        ))
    }

    pub(super) fn spawn_core(
        binary: &Path,
        args: &[&OsStr],
        current_dir: Option<&Path>,
        mut pipe: TokenPipe,
        options: SpawnOptions,
    ) -> io::Result<PlatformSpawn> {
        let parent_pid = unsafe { libc::getpid() };
        let write_fd = pipe.write_fd;
        let mut command = Command::new(binary);
        command.args(args);
        command.env(TOKEN_ENV, UNIX_TOKEN_FD.to_string());
        command.envs(options.child_env.iter().map(|(key, value)| (key, value)));
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        if let Some(directory) = current_dir {
            command.current_dir(directory);
        }
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                #[cfg(target_os = "linux")]
                {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if libc::getppid() != parent_pid {
                        return Err(io::Error::new(io::ErrorKind::BrokenPipe, "parent exited"));
                    }
                }
                if libc::dup2(write_fd, UNIX_TOKEN_FD) < 0 {
                    return Err(io::Error::last_os_error());
                }
                let flags = libc::fcntl(UNIX_TOKEN_FD, libc::F_GETFD);
                if flags < 0
                    || libc::fcntl(UNIX_TOKEN_FD, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                if write_fd != UNIX_TOKEN_FD {
                    libc::close(write_fd);
                }
                Ok(())
            });
        }
        let mut child = crate::process_spawn::spawn(&mut command)?;
        unsafe { libc::close(pipe.write_fd) };
        pipe.write_fd = -1;
        let stdout = child
            .stdout
            .take()
            .map(|stream| Box::new(stream) as Box<dyn Read + Send>);
        let stderr = child
            .stderr
            .take()
            .map(|stream| Box::new(stream) as Box<dyn Read + Send>);
        let identity = match process_identity(child.id() as i32) {
            Ok(identity) => identity,
            Err(error) => {
                terminate_group_and_reap(&mut child);
                return Err(error);
            }
        };
        let watchdog_result = spawn_parent_watchdog(
            identity,
            #[cfg(test)]
            options.watchdog_failure,
        );
        let (watchdog, watchdog_control) = match watchdog_result {
            Ok(watchdog) => watchdog,
            Err(error) => {
                terminate_group_and_reap(&mut child);
                return Err(error);
            }
        };
        Ok(PlatformSpawn {
            child: PlatformChild::Unix(UnixChild {
                child,
                watchdog: Some(watchdog),
                watchdog_control: Some(watchdog_control),
            }),
            stdout,
            stderr,
        })
    }

    fn terminate_group_and_reap(child: &mut Child) {
        if child.try_wait().ok().flatten().is_none() {
            let _ = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
        }
        let _ = child.wait();
    }

    fn spawn_parent_watchdog(
        identity: UnixProcessIdentity,
        #[cfg(test)] failure: Option<UnixWatchdogFailure>,
    ) -> io::Result<(Child, File)> {
        #[cfg(test)]
        if matches!(failure, Some(UnixWatchdogFailure::Pipe)) {
            return Err(io::Error::other("injected watchdog pipe failure"));
        }
        let [reader, control] = create_cloexec_pipe(CloexecPipeFault::None)?;
        let reader = File::from(reader);
        let control = File::from(control);
        #[cfg(test)]
        if matches!(failure, Some(UnixWatchdogFailure::CurrentExe)) {
            return Err(io::Error::other("injected watchdog executable failure"));
        }
        let executable = std::env::current_exe()?;
        let mut command = Command::new(executable);
        #[cfg(not(test))]
        command.args([
            "--tachyon-core-parent-watchdog",
            &identity.pid.to_string(),
            &identity.pgid.to_string(),
            &identity.started.to_string(),
            &UNIX_WATCHDOG_FD.to_string(),
        ]);
        #[cfg(test)]
        command
            .args([
                "--exact",
                "core_ipc::tests::parent_watchdog_fixture_child",
                "--nocapture",
            ])
            .env("TACHYON_TEST_WATCHDOG_CORE_PID", identity.pid.to_string())
            .env("TACHYON_TEST_WATCHDOG_CORE_PGID", identity.pgid.to_string())
            .env(
                "TACHYON_TEST_WATCHDOG_CORE_STARTED",
                identity.started.to_string(),
            )
            .env(
                "TACHYON_TEST_WATCHDOG_LIVENESS_FD",
                UNIX_WATCHDOG_FD.to_string(),
            );
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());
        let read_fd = reader.as_raw_fd();
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(read_fd, UNIX_WATCHDOG_FD) < 0 {
                    return Err(io::Error::last_os_error());
                }
                let flags = libc::fcntl(UNIX_WATCHDOG_FD, libc::F_GETFD);
                if flags < 0
                    || libc::fcntl(UNIX_WATCHDOG_FD, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                if read_fd != UNIX_WATCHDOG_FD {
                    libc::close(read_fd);
                }
                Ok(())
            });
        }
        #[cfg(test)]
        if matches!(failure, Some(UnixWatchdogFailure::Spawn)) {
            return Err(io::Error::other("injected watchdog spawn failure"));
        }
        let child = crate::process_spawn::spawn(&mut command)?;
        drop(reader);
        Ok((child, control))
    }
}

#[cfg(unix)]
pub(crate) fn run_parent_watchdog_from_args() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let Some(index) = args
        .iter()
        .position(|argument| argument == "--tachyon-core-parent-watchdog")
    else {
        return false;
    };
    let core_pid = args
        .get(index + 1)
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|value| *value > 1);
    let core_pgid = args
        .get(index + 2)
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|value| *value > 1);
    let core_started = args
        .get(index + 3)
        .and_then(|value| value.parse::<u128>().ok());
    let liveness_fd = args
        .get(index + 4)
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|value| *value > 2);
    if let (Some(pid), Some(pgid), Some(started), Some(liveness_fd)) =
        (core_pid, core_pgid, core_started, liveness_fd)
    {
        run_parent_watchdog(UnixProcessIdentity { pid, pgid, started }, liveness_fd);
    }
    true
}

#[cfg(unix)]
fn run_parent_watchdog(identity: UnixProcessIdentity, liveness_fd: i32) {
    let mut byte = [0_u8; 1];
    let normal_exit = loop {
        let read = unsafe { libc::read(liveness_fd, byte.as_mut_ptr().cast(), 1) };
        if read == 0 {
            break false;
        }
        if read < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break false;
        }
        if byte[0] == WATCHDOG_NORMAL_EXIT {
            break true;
        }
    };
    unsafe { libc::close(liveness_fd) };
    if !normal_exit && process_identity(identity.pid).ok() == Some(identity) {
        unsafe { libc::kill(-identity.pgid, libc::SIGKILL) };
    }
}

#[cfg(all(unix, target_os = "linux"))]
fn process_identity(pid: i32) -> io::Result<UnixProcessIdentity> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let suffix = stat
        .get(
            stat.rfind(')')
                .ok_or_else(|| io::Error::other("invalid process stat"))?
                + 1..,
        )
        .ok_or_else(|| io::Error::other("invalid process stat"))?;
    let fields: Vec<&str> = suffix.split_whitespace().collect();
    let pgid = fields
        .get(2)
        .and_then(|value| value.parse::<i32>().ok())
        .ok_or_else(|| io::Error::other("invalid process group identity"))?;
    let started = fields
        .get(19)
        .and_then(|value| value.parse::<u128>().ok())
        .ok_or_else(|| io::Error::other("invalid process start identity"))?;
    Ok(UnixProcessIdentity { pid, pgid, started })
}

#[cfg(all(unix, target_os = "macos"))]
fn process_identity(pid: i32) -> io::Result<UnixProcessIdentity> {
    use libproc::bsd_info::BSDInfo;
    use libproc::proc_pid::pidinfo;

    let info = pidinfo::<BSDInfo>(pid, 0).map_err(io::Error::other)?;
    Ok(UnixProcessIdentity {
        pid,
        pgid: info.pbi_pgid as i32,
        started: (u128::from(info.pbi_start_tvsec) << 64) | u128::from(info.pbi_start_tvusec),
    })
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn process_identity(_pid: i32) -> io::Result<UnixProcessIdentity> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "secure Core process identity is unsupported on this Unix platform",
    ))
}

#[cfg(not(unix))]
pub(crate) fn run_parent_watchdog_from_args() -> bool {
    false
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::os::windows::process::ExitStatusExt;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{
        CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTUPINFOEXW,
    };

    pub(super) struct TokenPipe {
        write: HANDLE,
    }

    impl Drop for TokenPipe {
        fn drop(&mut self) {
            if !self.write.is_null() {
                unsafe { CloseHandle(self.write) };
            }
        }
    }

    pub(super) struct WindowsChild {
        process: HANDLE,
        job: HANDLE,
        pid: u32,
        waited: Option<ExitStatus>,
    }

    // Kernel process and job handles may be waited, terminated, and closed from the
    // serialized runtime mutex on any Prism backend thread.
    unsafe impl Send for WindowsChild {}

    impl WindowsChild {
        pub(super) fn id(&self) -> u32 {
            self.pid
        }

        pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            if let Some(status) = self.waited {
                return Ok(Some(status));
            }
            match unsafe { WaitForSingleObject(self.process, 0) } {
                WAIT_TIMEOUT => Ok(None),
                WAIT_OBJECT_0 => self.read_exit_status().map(Some),
                _ => Err(io::Error::last_os_error()),
            }
        }

        pub(super) fn wait(&mut self) -> io::Result<ExitStatus> {
            if let Some(status) = self.waited {
                return Ok(status);
            }
            if unsafe { WaitForSingleObject(self.process, u32::MAX) } != WAIT_OBJECT_0 {
                return Err(io::Error::last_os_error());
            }
            self.read_exit_status()
        }

        fn read_exit_status(&mut self) -> io::Result<ExitStatus> {
            let mut code = 0;
            if unsafe { GetExitCodeProcess(self.process, &mut code) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let status = ExitStatus::from_raw(code);
            self.waited = Some(status);
            Ok(status)
        }

        pub(super) fn kill(&mut self) -> io::Result<()> {
            if self.try_wait()?.is_some() {
                return Ok(());
            }
            if unsafe { TerminateProcess(self.process, 1) } == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    }

    impl Drop for WindowsChild {
        fn drop(&mut self) {
            unsafe {
                if !self.job.is_null() {
                    CloseHandle(self.job);
                    self.job = null_mut();
                }
                if !self.process.is_null() {
                    let _ = WaitForSingleObject(self.process, 5_000);
                    CloseHandle(self.process);
                    self.process = null_mut();
                }
            }
        }
    }

    pub(super) fn create_token_pipe() -> io::Result<(File, TokenPipe)> {
        let mut read = null_mut();
        let mut write = null_mut();
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0) } == 0 {
            unsafe {
                CloseHandle(read);
                CloseHandle(write);
            }
            return Err(io::Error::last_os_error());
        }
        let reader = unsafe { File::from_raw_handle(read as RawHandle) };
        Ok((reader, TokenPipe { write }))
    }

    pub(super) fn spawn_core(
        binary: &Path,
        args: &[&OsStr],
        current_dir: Option<&Path>,
        mut pipe: TokenPipe,
        options: SpawnOptions,
    ) -> io::Result<PlatformSpawn> {
        let mut attribute_bytes = 0_usize;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_bytes);
        }
        if attribute_bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut attributes = vec![0_u8; attribute_bytes];
        let attribute_list = attributes.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_bytes) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        let handles = [pipe.write];
        let update_result = unsafe {
            UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                size_of_val(&handles),
                null_mut(),
                null(),
            )
        };
        if update_result == 0 {
            unsafe { DeleteProcThreadAttributeList(attribute_list) };
            return Err(io::Error::last_os_error());
        }

        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.lpAttributeList = attribute_list;
        let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
        let application = wide_null(binary.as_os_str());
        let mut command_line = wide_null(OsStr::new(&build_command_line(binary.as_os_str(), args)));
        let current_directory = current_dir.map(|path| wide_null(path.as_os_str()));
        let mut environment = environment_block(pipe.write as usize, &options.child_env);
        let flags = CREATE_NO_WINDOW
            | CREATE_SUSPENDED
            | CREATE_UNICODE_ENVIRONMENT
            | EXTENDED_STARTUPINFO_PRESENT;
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                flags,
                environment.as_mut_ptr().cast(),
                current_directory
                    .as_ref()
                    .map_or(null(), |directory| directory.as_ptr()),
                &startup.StartupInfo,
                &mut info,
            )
        };
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        if created == 0 {
            return Err(io::Error::last_os_error());
        }
        unsafe { CloseHandle(pipe.write) };
        pipe.write = null_mut();

        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job.is_null() {
            unsafe {
                TerminateProcess(info.hProcess, 1);
                CloseHandle(info.hThread);
                CloseHandle(info.hProcess);
            }
            return Err(io::Error::last_os_error());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        let assigned = if configured != 0 {
            unsafe { AssignProcessToJobObject(job, info.hProcess) }
        } else {
            0
        };
        if configured == 0 || assigned == 0 || unsafe { ResumeThread(info.hThread) } == u32::MAX {
            let error = io::Error::last_os_error();
            unsafe {
                TerminateProcess(info.hProcess, 1);
                CloseHandle(job);
                CloseHandle(info.hThread);
                CloseHandle(info.hProcess);
            }
            return Err(error);
        }
        unsafe { CloseHandle(info.hThread) };
        Ok(PlatformSpawn {
            child: PlatformChild::Windows(WindowsChild {
                process: info.hProcess,
                job,
                pid: info.dwProcessId,
                waited: None,
            }),
            stdout: None,
            stderr: None,
        })
    }

    fn environment_block(token_handle: usize, child_env: &[(OsString, OsString)]) -> Vec<u16> {
        let mut entries: Vec<(String, String)> = std::env::vars_os()
            .filter_map(|(key, value)| {
                let key = key.to_string_lossy().into_owned();
                if key.eq_ignore_ascii_case(TOKEN_ENV) || key.contains('=') || key.is_empty() {
                    None
                } else {
                    Some((key, value.to_string_lossy().into_owned()))
                }
            })
            .collect();
        for (key, value) in child_env {
            let key = key.to_string_lossy().into_owned();
            if key.eq_ignore_ascii_case(TOKEN_ENV) || key.contains('=') || key.is_empty() {
                continue;
            }
            entries.retain(|(existing, _)| !existing.eq_ignore_ascii_case(&key));
            entries.push((key, value.to_string_lossy().into_owned()));
        }
        entries.push((TOKEN_ENV.to_string(), token_handle.to_string()));
        entries.sort_by(|left, right| {
            left.0
                .to_ascii_lowercase()
                .cmp(&right.0.to_ascii_lowercase())
        });
        let mut block = Vec::new();
        for (key, value) in entries {
            block.extend(OsStr::new(&format!("{key}={value}")).encode_wide());
            block.push(0);
        }
        block.push(0);
        block
    }

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    fn build_command_line(binary: &OsStr, args: &[&OsStr]) -> String {
        std::iter::once(binary)
            .chain(args.iter().copied())
            .map(quote_windows_argument)
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn quote_windows_argument(value: &OsStr) -> String {
        let value = value.to_string_lossy();
        if !value.is_empty() && !value.contains([' ', '\t', '"']) {
            return value.into_owned();
        }
        let mut quoted = String::from("\"");
        let mut backslashes = 0;
        for character in value.chars() {
            match character {
                '\\' => backslashes += 1,
                '"' => {
                    quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                    quoted.push('"');
                    backslashes = 0;
                }
                _ => {
                    quoted.push_str(&"\\".repeat(backslashes));
                    backslashes = 0;
                    quoted.push(character);
                }
            }
        }
        quoted.push_str(&"\\".repeat(backslashes * 2));
        quoted.push('"');
        quoted
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
mod platform {
    use super::*;

    pub(super) struct TokenPipe;

    pub(super) fn create_token_pipe() -> io::Result<(File, TokenPipe)> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "secure Core IPC is unsupported on this platform",
        ))
    }

    pub(super) fn spawn_core(
        _binary: &Path,
        _args: &[&OsStr],
        _current_dir: Option<&Path>,
        _pipe: TokenPipe,
        _options: SpawnOptions,
    ) -> io::Result<PlatformSpawn> {
        unreachable!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::ffi::OsStr;
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[test]
    fn validates_exact_token_message_without_exposing_secret() {
        let encoded = URL_SAFE_NO_PAD.encode([7_u8; TOKEN_BYTES]);
        let message = format!("{encoded}\n");
        let parsed = validate_token_message(message.as_bytes());
        assert!(parsed.is_ok(), "valid token handoff must be accepted");
        assert_eq!(
            parsed.as_ref().map(|value| value.len()),
            Ok(TOKEN_ENCODED_BYTES)
        );
    }

    #[test]
    fn rejects_malformed_and_appended_token_messages() {
        let encoded = URL_SAFE_NO_PAD.encode([9_u8; TOKEN_BYTES]);
        for message in [
            encoded.clone(),
            format!("{encoded}\r\n"),
            format!("{encoded}\nextra"),
            format!("{}!\n", &encoded[..TOKEN_ENCODED_BYTES - 1]),
        ] {
            assert!(
                validate_token_message(message.as_bytes()).is_err(),
                "malformed token handoff must fail without rendering its contents"
            );
        }
    }

    #[test]
    fn token_handoff_fixture_child() {
        let Ok(mode) = std::env::var("TACHYON_TEST_CORE_TOKEN_MODE") else {
            return;
        };
        let raw_handle = std::env::var(TOKEN_ENV)
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 2)
            .expect("fixture requires inherited token handle");
        #[cfg(unix)]
        assert_eq!(raw_handle as i32, UNIX_TOKEN_FD, "token FD must be exact");
        let mut pipe = fixture_pipe_from_raw(raw_handle);
        match mode.as_str() {
            "early-exit" => return,
            "timeout" => {
                thread::sleep(Duration::from_secs(30));
                return;
            }
            "malformed" => pipe.write_all(b"invalid\n").unwrap(),
            "extra" => {
                let encoded = URL_SAFE_NO_PAD.encode([11_u8; TOKEN_BYTES]);
                pipe.write_all(format!("{encoded}\nextra").as_bytes())
                    .unwrap();
            }
            "valid" | "valid-sleep" => {
                let mut secret = Zeroizing::new([0_u8; TOKEN_BYTES]);
                rand::fill(&mut *secret);
                let encoded = Zeroizing::new(URL_SAFE_NO_PAD.encode(*secret));
                pipe.write_all(encoded.as_bytes()).unwrap();
                pipe.write_all(b"\n").unwrap();
            }
            _ => panic!("unknown non-secret fixture mode"),
        }
        drop(pipe);
        if mode == "valid-sleep" {
            thread::sleep(Duration::from_secs(30));
        }
    }

    #[cfg(target_os = "windows")]
    fn fixture_pipe_from_raw(raw: u64) -> File {
        use std::os::windows::io::{FromRawHandle, RawHandle};
        unsafe { File::from_raw_handle(raw as usize as RawHandle) }
    }

    #[cfg(unix)]
    fn fixture_pipe_from_raw(raw: u64) -> File {
        use std::os::fd::FromRawFd;
        unsafe { File::from_raw_fd(raw as i32) }
    }

    fn spawn_fixture(mode: &str, timeout: Duration) -> Result<SpawnedCore, String> {
        spawn_fixture_with_options(mode, timeout, SpawnOptions::default())
    }

    fn spawn_fixture_with_options(
        mode: &str,
        timeout: Duration,
        mut options: SpawnOptions,
    ) -> Result<SpawnedCore, String> {
        let executable = std::env::current_exe().expect("test executable");
        options.child_env.push((
            OsString::from("TACHYON_TEST_CORE_TOKEN_MODE"),
            OsString::from(mode),
        ));
        let arguments = [
            OsStr::new("--exact"),
            OsStr::new("core_ipc::tests::token_handoff_fixture_child"),
            OsStr::new("--nocapture"),
        ];
        spawn_with_options(&executable, &arguments, None, timeout, options)
    }

    #[test]
    fn cross_process_handoff_accepts_exact_token_and_rotates_on_restart() {
        let mut first =
            spawn_fixture("valid-sleep", Duration::from_secs(5)).expect("first secure handoff");
        let first_digest = Sha256::digest(first.child.bearer().as_bytes());
        first.child.kill().expect("stop first fixture");
        first.child.wait().expect("reap first fixture");
        drop(first);

        let mut second =
            spawn_fixture("valid-sleep", Duration::from_secs(5)).expect("second secure handoff");
        let second_digest = Sha256::digest(second.child.bearer().as_bytes());
        assert_ne!(
            first_digest.as_slice(),
            second_digest.as_slice(),
            "a restarted Core must receive a fresh in-memory session token"
        );
        second.child.kill().expect("stop second fixture");
        second.child.wait().expect("reap second fixture");
    }

    #[test]
    fn cross_process_handoff_fails_closed_for_bad_eof_extra_and_timeout() {
        for (mode, timeout) in [
            ("malformed", Duration::from_secs(5)),
            ("early-exit", Duration::from_secs(5)),
            ("extra", Duration::from_secs(5)),
            ("timeout", Duration::from_millis(150)),
        ] {
            let result = spawn_fixture(mode, timeout);
            assert!(
                result.is_err(),
                "invalid token fixture must fail without exposing token material"
            );
        }
    }

    #[test]
    fn ordinary_xray_style_child_does_not_receive_core_handoff() {
        let mut core =
            spawn_fixture("valid-sleep", Duration::from_secs(5)).expect("secure handoff fixture");
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command.args([
            "--exact",
            "core_ipc::tests::uninherited_token_fixture_child",
            "--nocapture",
        ]);
        let output = crate::process_spawn::output(&mut command).expect("ordinary child fixture");
        assert!(
            output.status.success(),
            "ordinary child must not inherit Core IPC state"
        );
        core.child.kill().expect("stop fixture");
        core.child.wait().expect("reap fixture");
    }

    #[test]
    fn uninherited_token_fixture_child() {
        assert!(
            std::env::var_os(TOKEN_ENV).is_none(),
            "ordinary child must not receive the Core token handle environment"
        );
        #[cfg(unix)]
        assert_eq!(
            unsafe { libc::fcntl(UNIX_TOKEN_FD, libc::F_GETFD) },
            -1,
            "ordinary child must not inherit the fixed Core token descriptor"
        );
    }

    #[cfg(unix)]
    #[test]
    fn parent_watchdog_fixture_child() {
        let Ok(core_pid) = std::env::var("TACHYON_TEST_WATCHDOG_CORE_PID") else {
            return;
        };
        let liveness_fd = std::env::var("TACHYON_TEST_WATCHDOG_LIVENESS_FD")
            .ok()
            .and_then(|value| value.parse::<i32>().ok())
            .expect("watchdog liveness descriptor");
        assert_eq!(liveness_fd, UNIX_WATCHDOG_FD, "watchdog FD must be exact");
        let pgid = std::env::var("TACHYON_TEST_WATCHDOG_CORE_PGID")
            .expect("watchdog process group")
            .parse()
            .expect("watchdog process group");
        let started = std::env::var("TACHYON_TEST_WATCHDOG_CORE_STARTED")
            .expect("watchdog process identity")
            .parse()
            .expect("watchdog process identity");
        run_parent_watchdog(
            UnixProcessIdentity {
                pid: core_pid.parse().expect("watchdog core pid"),
                pgid,
                started,
            },
            liveness_fd,
        );
    }

    #[cfg(unix)]
    #[test]
    fn watchdog_setup_failures_reap_the_started_core_group() {
        for failure in [
            UnixWatchdogFailure::Pipe,
            UnixWatchdogFailure::CurrentExe,
            UnixWatchdogFailure::Spawn,
        ] {
            let options = SpawnOptions {
                watchdog_failure: Some(failure),
                ..SpawnOptions::default()
            };
            assert!(
                spawn_fixture_with_options("valid-sleep", Duration::from_secs(5), options).is_err(),
                "an injected watchdog setup failure must fail closed"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn watchdog_normal_exit_message_does_not_kill_a_live_core_group() {
        use std::os::fd::{FromRawFd, IntoRawFd};
        use std::os::unix::process::CommandExt;

        let mut target = Command::new(std::env::current_exe().expect("test executable"));
        target
            .args([
                "--exact",
                "core_ipc::tests::watchdog_signal_target_fixture_child",
                "--nocapture",
            ])
            .env("TACHYON_TEST_WATCHDOG_SIGNAL_TARGET", "1");
        unsafe {
            target.pre_exec(|| {
                if libc::setpgid(0, 0) == 0 {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error())
                }
            });
        }
        let mut target = crate::process_spawn::spawn(&mut target).expect("watchdog signal target");
        let identity = process_identity(target.id() as i32).expect("target process identity");
        let mut fds = [-1; 2];
        assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
        let read_fd = unsafe { File::from_raw_fd(fds[0]) }.into_raw_fd();
        let mut control = unsafe { File::from_raw_fd(fds[1]) };
        let watchdog = thread::spawn(move || run_parent_watchdog(identity, read_fd));
        control
            .write_all(&[WATCHDOG_NORMAL_EXIT])
            .expect("normal watchdog completion");
        drop(control);
        watchdog.join().expect("watchdog thread");
        assert!(
            process_exists(target.id()),
            "normal Prism shutdown must not signal a still-identical Core group"
        );
        unsafe { libc::kill(-(target.id() as i32), libc::SIGKILL) };
        target.wait().expect("reap watchdog signal target");
    }

    #[cfg(unix)]
    #[test]
    fn watchdog_signal_target_fixture_child() {
        if std::env::var_os("TACHYON_TEST_WATCHDOG_SIGNAL_TARGET").is_some() {
            thread::sleep(Duration::from_secs(30));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn darwin_cloexec_pipe_sets_both_ends_and_fcntl_faults_fail_closed() {
        use std::os::fd::AsRawFd;

        let pipe = create_cloexec_pipe(CloexecPipeFault::None).expect("Darwin CLOEXEC pipe");
        for fd in &pipe {
            let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
            assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0);
        }
        drop(pipe);
        for fault in [CloexecPipeFault::FirstFcntl, CloexecPipeFault::SecondFcntl] {
            assert!(create_cloexec_pipe(fault).is_err());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn darwin_fd_probe_fixture_child() {
        let Some(first) = std::env::var("TACHYON_TEST_DARWIN_PIPE_FD_0")
            .ok()
            .and_then(|value| value.parse::<i32>().ok())
        else {
            return;
        };
        let second = std::env::var("TACHYON_TEST_DARWIN_PIPE_FD_1")
            .expect("second Darwin pipe FD")
            .parse::<i32>()
            .expect("second Darwin pipe FD");
        assert_eq!(unsafe { libc::fcntl(first, libc::F_GETFD) }, -1);
        assert_eq!(unsafe { libc::fcntl(second, libc::F_GETFD) }, -1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn darwin_pipe_window_blocks_concurrent_spawn_and_prevents_fd_leak() {
        use std::sync::mpsc;

        let (created_tx, created_rx) = mpsc::sync_channel(1);
        let (mark_tx, mark_rx) = mpsc::sync_channel(1);
        let (close_tx, close_rx) = mpsc::sync_channel(1);
        let creator = thread::spawn(move || {
            let guard = crate::process_spawn::fd_spawn_guard().expect("FD/spawn guard");
            let mut raw = [-1; 2];
            assert_eq!(unsafe { libc::pipe(raw.as_mut_ptr()) }, 0);
            created_tx.send(raw).expect("publish unprotected pipe");
            mark_rx.recv().expect("mark CLOEXEC");
            for fd in raw {
                let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
                assert!(flags >= 0);
                assert_eq!(
                    unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) },
                    0
                );
            }
            drop(guard);
            close_rx.recv().expect("spawn completed");
            for fd in raw {
                unsafe { libc::close(fd) };
            }
        });
        let raw = created_rx.recv().expect("unprotected pipe descriptors");
        let (spawn_tx, spawn_rx) = mpsc::sync_channel(1);
        let spawner = thread::spawn(move || {
            let mut command = Command::new(std::env::current_exe().expect("test executable"));
            command
                .args([
                    "--exact",
                    "core_ipc::tests::darwin_fd_probe_fixture_child",
                    "--nocapture",
                ])
                .env("TACHYON_TEST_DARWIN_PIPE_FD_0", raw[0].to_string())
                .env("TACHYON_TEST_DARWIN_PIPE_FD_1", raw[1].to_string());
            let output = crate::process_spawn::output(&mut command).expect("Darwin FD probe");
            spawn_tx
                .send(output.status.success())
                .expect("publish probe result");
        });
        assert!(spawn_rx.recv_timeout(Duration::from_millis(100)).is_err());
        mark_tx.send(()).expect("release pipe setup");
        assert!(spawn_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("Darwin FD probe result"));
        close_tx.send(()).expect("close temporary pipe");
        spawner.join().expect("spawn fixture thread");
        creator.join().expect("pipe creator thread");
    }

    #[test]
    fn crashing_parent_fixture_child() {
        let Some(pid_path) = std::env::var_os("TACHYON_TEST_CRASH_PID_PATH") else {
            return;
        };
        let core =
            spawn_fixture("valid-sleep", Duration::from_secs(5)).expect("crash cleanup fixture");
        std::fs::write(pid_path, core.child.id().to_string()).expect("write non-secret child pid");
        std::mem::forget(core);
        std::process::exit(0);
    }

    #[test]
    fn prism_process_exit_cleans_core_child() {
        let pid_path = unique_pid_path();
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command
            .args([
                "--exact",
                "core_ipc::tests::crashing_parent_fixture_child",
                "--nocapture",
            ])
            .env("TACHYON_TEST_CRASH_PID_PATH", &pid_path);
        let status = crate::process_spawn::status(&mut command).expect("crashing parent fixture");
        assert!(
            status.success(),
            "crashing parent fixture must reach simulated exit"
        );
        let pid: u32 = std::fs::read_to_string(&pid_path)
            .expect("read child pid")
            .parse()
            .expect("parse child pid");
        let _ = std::fs::remove_file(&pid_path);
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_exists(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            !process_exists(pid),
            "parent exit must clean the managed Core process"
        );
    }

    fn unique_pid_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "tachyon-prism-core-cleanup-{}-{}.pid",
            std::process::id(),
            rand::random::<u64>()
        ))
    }

    #[cfg(target_os = "windows")]
    fn process_exists(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            false
        } else {
            unsafe { CloseHandle(handle) };
            true
        }
    }

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}
