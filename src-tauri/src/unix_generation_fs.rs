use rustix::fs::{
    fchmod, fstat, fsync, openat, renameat, renameat_with, statat, unlinkat, AtFlags, Dir,
    FileType, Mode, OFlags, RenameFlags, Stat,
};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(test)]
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
static AFTER_PUBLISH_HOOK: OnceLock<Mutex<Option<Box<dyn FnOnce() + Send>>>> = OnceLock::new();

#[derive(Debug)]
pub(crate) struct Entry {
    pub(crate) name: OsString,
    pub(crate) modified_seconds: i128,
    pub(crate) modified_nanoseconds: i128,
}

pub(crate) fn validate_component(name: &OsStr) -> io::Result<()> {
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "generation name must be one ordinary path component",
        ));
    }
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.contains(&0) || bytes.contains(&b'/') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "generation name contains an invalid byte",
        ));
    }
    Ok(())
}

pub(crate) fn write_new(root: &File, name: &OsStr, contents: &[u8]) -> io::Result<File> {
    validate_root(root)?;
    validate_component(name)?;
    let temporary = temporary_name();
    let mut published_stat = None;
    let result = (|| {
        let mut file = create_private(root, &temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        let original = validate_open_regular(&file)?;
        renameat_with(root, &temporary, root, name, RenameFlags::NOREPLACE)
            .map_err(io::Error::from)?;
        published_stat = Some(original);
        fsync(root).map_err(io::Error::from)?;
        #[cfg(test)]
        invoke_after_publish_hook();
        let published = statat(root, name, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
        validate_stat(&published)?;
        if published.st_dev != original.st_dev || published.st_ino != original.st_ino {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "generation entry changed after publication",
            ));
        }
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    })();
    if result.is_err() {
        if let Some(original) = published_stat {
            if let Ok(published) = statat(root, name, AtFlags::SYMLINK_NOFOLLOW) {
                if published.st_dev == original.st_dev && published.st_ino == original.st_ino {
                    let _ = unlinkat(root, name, AtFlags::empty());
                    let _ = fsync(root);
                }
            }
        } else {
            let _ = unlinkat(root, &temporary, AtFlags::empty());
        }
    }
    result
}

#[cfg(test)]
pub(crate) fn set_after_publish_hook(hook: impl FnOnce() + Send + 'static) {
    let slot = AFTER_PUBLISH_HOOK.get_or_init(|| Mutex::new(None));
    *slot.lock().unwrap() = Some(Box::new(hook));
}

#[cfg(test)]
fn invoke_after_publish_hook() {
    let hook = AFTER_PUBLISH_HOOK
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap()
        .take();
    if let Some(hook) = hook {
        hook();
    }
}

pub(crate) fn replace(root: &File, name: &OsStr, contents: &[u8]) -> io::Result<()> {
    validate_root(root)?;
    validate_component(name)?;
    match statat(root, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => validate_stat(&stat)?,
        Err(rustix::io::Errno::NOENT) => {}
        Err(error) => return Err(error.into()),
    }
    let temporary = temporary_name();
    let result = (|| {
        let mut file = create_private(root, &temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        validate_open_regular(&file)?;
        renameat(root, &temporary, root, name).map_err(io::Error::from)?;
        fsync(root).map_err(io::Error::from)
    })();
    if result.is_err() {
        let _ = unlinkat(root, &temporary, AtFlags::empty());
    }
    result
}

pub(crate) fn open_read(root: &File, name: &OsStr) -> io::Result<File> {
    validate_root(root)?;
    validate_component(name)?;
    let descriptor = openat(
        root,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(io::Error::from)?;
    let file = File::from(descriptor);
    let opened = validate_open_regular(&file)?;
    let linked = statat(root, name, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
    validate_stat(&linked)?;
    if opened.st_dev != linked.st_dev || opened.st_ino != linked.st_ino {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "generation entry changed while opening",
        ));
    }
    Ok(file)
}

pub(crate) fn remove(root: &File, name: &OsStr) -> io::Result<()> {
    validate_root(root)?;
    validate_component(name)?;
    let stat = statat(root, name, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
    validate_stat(&stat)?;
    unlinkat(root, name, AtFlags::empty()).map_err(io::Error::from)?;
    fsync(root).map_err(io::Error::from)
}

pub(crate) fn list(root: &File) -> io::Result<Vec<Entry>> {
    validate_root(root)?;
    let mut entries = Vec::new();
    let directory = Dir::read_from(root).map_err(io::Error::from)?;
    for entry in directory {
        let entry = entry.map_err(io::Error::from)?;
        let bytes = entry.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        let name = OsString::from_vec(bytes.to_vec());
        validate_component(&name)?;
        let stat = statat(root, &name, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
        validate_stat(&stat)?;
        entries.push(Entry {
            name,
            modified_seconds: stat.st_mtime.into(),
            modified_nanoseconds: stat.st_mtime_nsec.into(),
        });
    }
    Ok(entries)
}

pub(crate) fn validate_open_regular(file: &File) -> io::Result<Stat> {
    let stat = fstat(file).map_err(io::Error::from)?;
    validate_stat(&stat)?;
    Ok(stat)
}

pub(crate) fn validate_root(root: &File) -> io::Result<Stat> {
    let stat = fstat(root).map_err(io::Error::from)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::Directory
        || stat.st_uid != unsafe { libc::geteuid() }
        || stat.st_mode & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "generation root is not a private owned directory",
        ));
    }
    Ok(stat)
}

fn create_private(root: &File, name: &OsStr) -> io::Result<File> {
    validate_component(name)?;
    let descriptor = openat(
        root,
        name,
        OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(io::Error::from)?;
    let file = File::from(descriptor);
    fchmod(&file, Mode::RUSR | Mode::WUSR).map_err(io::Error::from)?;
    validate_open_regular(&file)?;
    Ok(file)
}

fn validate_stat(stat: &Stat) -> io::Result<()> {
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile
        || stat.st_nlink != 1
        || stat.st_uid != unsafe { libc::geteuid() }
        || stat.st_mode & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "generation entry is not a private, owned, single-link regular file",
        ));
    }
    Ok(())
}

fn temporary_name() -> OsString {
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    OsString::from(format!(
        ".tachyon-{}-{epoch:032x}-{counter:016x}.tmp",
        std::process::id()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::fs::{symlink, MetadataExt};

    fn root() -> (tempfile::TempDir, File) {
        let temporary = tempfile::tempdir().unwrap();
        let file = File::open(temporary.path()).unwrap();
        (temporary, file)
    }

    #[test]
    fn rejects_non_component_names() {
        for name in ["", ".", "..", "a/b", "/absolute"] {
            assert!(
                validate_component(OsStr::new(name)).is_err(),
                "accepted {name:?}"
            );
        }
    }

    #[test]
    fn open_and_remove_reject_symlink_and_hardlink_anomalies() {
        let (temporary, directory) = root();
        let target = temporary.path().join("target");
        std::fs::write(&target, b"secret").unwrap();
        std::fs::set_permissions(&target, std::os::unix::fs::PermissionsExt::from_mode(0o600))
            .unwrap();
        symlink(&target, temporary.path().join("linked")).unwrap();
        assert!(open_read(&directory, OsStr::new("linked")).is_err());

        std::fs::hard_link(&target, temporary.path().join("hardlinked")).unwrap();
        assert!(remove(&directory, OsStr::new("hardlinked")).is_err());
        assert_eq!(std::fs::metadata(target).unwrap().nlink(), 2);
    }

    #[test]
    fn operations_reject_a_root_that_becomes_group_accessible() {
        let (temporary, directory) = root();
        std::fs::set_permissions(
            temporary.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o750),
        )
        .unwrap();
        assert!(list(&directory).is_err());
        assert!(write_new(&directory, OsStr::new("generation.json"), b"{}").is_err());
    }

    #[test]
    fn write_new_returns_the_published_descriptor_at_offset_zero() {
        let (temporary, directory) = root();
        let file = write_new(&directory, OsStr::new("generation.json"), b"config").unwrap();
        let opened = validate_open_regular(&file).unwrap();
        let linked = statat(
            &directory,
            OsStr::new("generation.json"),
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .unwrap();
        assert_eq!(opened.st_dev, linked.st_dev);
        assert_eq!(opened.st_ino, linked.st_ino);
        let mut contents = Vec::new();
        (&file).read_to_end(&mut contents).unwrap();
        assert_eq!(contents, b"config");
        drop(file);
        assert_eq!(
            std::fs::read(temporary.path().join("generation.json")).unwrap(),
            b"config"
        );
    }

    #[test]
    fn write_new_rejects_post_publish_swap_without_deleting_replacement() {
        let (temporary, directory) = root();
        let path = temporary.path().join("generation.json");
        set_after_publish_hook({
            let path = path.clone();
            move || {
                let saved = temporary.path().join("published-original");
                std::fs::rename(&path, saved).unwrap();
                std::fs::write(&path, b"replacement").unwrap();
                std::fs::set_permissions(
                    &path,
                    std::os::unix::fs::PermissionsExt::from_mode(0o600),
                )
                .unwrap();
            }
        });
        assert!(write_new(&directory, OsStr::new("generation.json"), b"config").is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"replacement");
    }
}
