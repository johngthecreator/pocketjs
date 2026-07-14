//! PSP backing store for the private `globalThis.__pocketStorage` bridge.
//!
//! The framework validates and versions the document; this module owns only
//! a small per-app byte blob and keeps the previous successful blob as a
//! recovery copy.

use alloc::string::String;
use alloc::vec::Vec;
use core::ffi::c_void;
use psp::sys::{self, IoOpenFlags};

const MAX_BYTES: usize = 64 * 1024;
static mut PATH: Option<Vec<u8>> = None;
static mut BACKUP_PATH: Option<Vec<u8>> = None;
static mut TEMP_PATH: Option<Vec<u8>> = None;

fn path_for(app_id: &str, suffix: &[u8]) -> Vec<u8> {
    let mut path = b"ms0:/PSP/SAVEDATA/POCKETJS/".to_vec();
    path.extend_from_slice(app_id.as_bytes());
    path.extend_from_slice(suffix);
    path.push(0);
    path
}

unsafe fn read(path: &[u8]) -> Option<String> {
    let fd = sys::sceIoOpen(path.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
    if fd.0 < 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(4096);
    let mut buf = [0u8; 1024];
    loop {
        let n = sys::sceIoRead(fd, buf.as_mut_ptr() as *mut c_void, buf.len() as u32);
        if n <= 0 {
            break;
        }
        if bytes.len() + n as usize > MAX_BYTES {
            sys::sceIoClose(fd);
            return None;
        }
        bytes.extend_from_slice(&buf[..n as usize]);
    }
    sys::sceIoClose(fd);
    String::from_utf8(bytes).ok()
}

unsafe fn write(path: &[u8], data: &[u8]) -> bool {
    let fd = sys::sceIoOpen(
        path.as_ptr(),
        IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC,
        0o777,
    );
    if fd.0 < 0 {
        return false;
    }
    let mut written = 0usize;
    while written < data.len() {
        let wrote = sys::sceIoWrite(
            fd,
            data.as_ptr().add(written) as *const c_void,
            data.len() - written,
        );
        if wrote <= 0 {
            sys::sceIoClose(fd);
            return false;
        }
        written += wrote as usize;
    }
    sys::sceIoClose(fd);
    sys::sceIoSync(b"ms0:\0".as_ptr(), 0) >= 0
}

pub unsafe fn init(app_id: &str) {
    // Existing folders yield an error, which is harmless.
    sys::sceIoMkdir(b"ms0:/PSP\0".as_ptr(), 0o777);
    sys::sceIoMkdir(b"ms0:/PSP/SAVEDATA\0".as_ptr(), 0o777);
    sys::sceIoMkdir(b"ms0:/PSP/SAVEDATA/POCKETJS\0".as_ptr(), 0o777);
    PATH = Some(path_for(app_id, b".storage"));
    BACKUP_PATH = Some(path_for(app_id, b".storage.bak"));
    TEMP_PATH = Some(path_for(app_id, b".storage.tmp"));
    if let Some(temp) = TEMP_PATH.as_ref() {
        sys::sceIoRemove(temp.as_ptr());
    }
}

pub unsafe fn load() -> Option<String> {
    let path = PATH.as_ref()?;
    read(path)
}

pub unsafe fn load_backup() -> Option<String> {
    BACKUP_PATH.as_ref().and_then(|backup| read(backup))
}

pub unsafe fn commit(snapshot: &str, preserve_backup: bool) -> bool {
    if snapshot.len() > MAX_BYTES {
        return false;
    }
    let Some(path) = PATH.as_ref() else {
        return false;
    };
    let Some(backup) = BACKUP_PATH.as_ref() else {
        return false;
    };
    let Some(temp) = TEMP_PATH.as_ref() else {
        return false;
    };

    sys::sceIoRemove(temp.as_ptr());
    if !write(temp, snapshot.as_bytes()) || read(temp).as_deref() != Some(snapshot) {
        sys::sceIoRemove(temp.as_ptr());
        return false;
    }

    if preserve_backup {
        // The framework rejected the primary and recovered from backup. Never
        // rotate that corrupt primary over the last known-good document.
        sys::sceIoRemove(path.as_ptr());
    } else {
        sys::sceIoRemove(backup.as_ptr());
        // Missing primary is the first-save case; the rename failure is safe
        // to ignore because the validated temp file is still intact.
        sys::sceIoRename(path.as_ptr(), backup.as_ptr());
    }

    if sys::sceIoRename(temp.as_ptr(), path.as_ptr()) < 0 {
        return false;
    }
    sys::sceIoSync(b"ms0:\0".as_ptr(), 0) >= 0
}
