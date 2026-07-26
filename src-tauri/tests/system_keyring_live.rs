#![cfg(feature = "system-keyring-live-test")]

use keyring::{Entry, Error};
use rand::RngExt;
use zeroize::Zeroizing;

const LIVE_TEST_ENV: &str = "TACHYON_PRISM_SYSTEM_KEYRING_LIVE";

struct CredentialCleanup {
    entry: Entry,
}

impl Drop for CredentialCleanup {
    fn drop(&mut self) {
        let _ = self.entry.delete_credential();
    }
}

fn random_hex<const N: usize>() -> String {
    let mut bytes = [0_u8; N];
    rand::rng().fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
#[ignore = "requires an explicitly isolated operating-system credential service"]
fn system_keyring_round_trip() {
    assert_eq!(
        std::env::var(LIVE_TEST_ENV).as_deref(),
        Ok("1"),
        "system keyring live test requires the explicit opt-in environment variable"
    );

    let identity = random_hex::<32>();
    let service = format!("io.tachyon.prism.live-test.{identity}");
    let account = format!("credential-{identity}");
    let secret = Zeroizing::new(random_hex::<32>().into_bytes());
    let entry = Entry::new(&service, &account)
        .unwrap_or_else(|_| panic!("system keyring live test could not create an entry handle"));
    let cleanup = CredentialCleanup { entry };

    let operation = (|| -> Result<(), &'static str> {
        match cleanup.entry.get_secret() {
            Err(Error::NoEntry) => {}
            Ok(_) => return Err("unique system keyring test entry unexpectedly existed"),
            Err(_) => return Err("system keyring was unavailable before the write"),
        }

        cleanup
            .entry
            .set_secret(secret.as_slice())
            .map_err(|_| "system keyring write failed")?;
        let reread = Zeroizing::new(
            cleanup
                .entry
                .get_secret()
                .map_err(|_| "system keyring read failed")?,
        );
        if reread.as_slice() != secret.as_slice() {
            return Err("system keyring returned a different value");
        }
        Ok(())
    })();

    let deletion = cleanup.entry.delete_credential();
    let absence = cleanup.entry.get_secret();
    if let Err(message) = operation {
        panic!("{message}; cleanup was attempted before this failure was reported");
    }
    if !matches!(deletion, Ok(()) | Err(Error::NoEntry)) {
        panic!("system keyring live test could not delete its unique entry");
    }
    if !matches!(absence, Err(Error::NoEntry)) {
        panic!("system keyring live test entry remained after deletion");
    }

    // The explicit deletion and absence check succeeded, so Drop is only a fallback.
    cleanup.entry.delete_credential().ok();
}
