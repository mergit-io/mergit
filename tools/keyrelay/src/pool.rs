//! The key pool: pure state, no I/O, time passed in so tests control it.
//!
//! Keys sit in a deque. The **back** is the top: `acquire` returns the topmost key that is usable and leaves it
//! in place, so one key is spent at a time (LIFO). When a key is rate limited it is removed and pushed to the
//! **front** (the bottom) with a cooldown, and `acquire` skips keys that are cooling or dead.
//!
//! A key's `index` is its position in the keys file at start-up and never changes. Logs and status use the index;
//! nothing here ever formats a secret.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct Policy {
    /// Cooldown when the provider gave no usable `Retry-After`.
    pub default_cooldown: Duration,
    pub min_cooldown: Duration,
    /// A daily-quota 429 can carry a huge `Retry-After`; it is clamped to this.
    pub max_cooldown: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            default_cooldown: Duration::from_secs(60),
            min_cooldown: Duration::from_secs(1),
            max_cooldown: Duration::from_secs(24 * 60 * 60),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Ok,
    Cooling(Instant),
    Dead,
}

struct Key {
    index: usize,
    secret: Arc<str>,
    state: State,
    /// Bumped on every state change, so a late 429 for a key another request already rotated is ignored.
    generation: u64,
}

// Written by hand so that formatting a pool (a stray `{:?}`) can never print a secret.
impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Key")
            .field("index", &self.index)
            .field("secret", &"<redacted>")
            .field("state", &self.state)
            .field("generation", &self.generation)
            .finish()
    }
}

/// What `acquire` hands out; passed back to say what happened to the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Handle {
    index: usize,
    generation: u64,
}

impl Handle {
    pub fn index(self) -> usize {
        self.index
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    /// Every usable key is cooling; the soonest comes back at `next_at`.
    AllLimited { next_at: Instant, limited: usize },
    /// Every key was refused (401/403). Nothing will become usable by waiting.
    AllDead,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct KeyStatus {
    pub index: usize,
    pub state: &'static str,
    pub usable_in_s: Option<u64>,
}

#[derive(Debug)]
pub struct Pool {
    keys: VecDeque<Key>,
    policy: Policy,
}

impl Pool {
    /// `secrets` in file order: the **last** one is the top and is used first. `None` when there are no keys.
    pub fn new(secrets: Vec<String>, policy: Policy) -> Option<Self> {
        if secrets.is_empty() {
            return None;
        }
        let keys = secrets
            .into_iter()
            .enumerate()
            .map(|(index, s)| Key {
                index,
                secret: s.into(),
                state: State::Ok,
                generation: 0,
            })
            .collect();
        Some(Self { keys, policy })
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// The topmost usable key, left in place.
    pub fn acquire(&mut self, now: Instant) -> Result<(Handle, Arc<str>), Unavailable> {
        let mut soonest: Option<Instant> = None;
        let mut limited = 0;
        for k in self.keys.iter_mut().rev() {
            match k.state {
                State::Ok => {}
                State::Cooling(until) if until <= now => k.state = State::Ok,
                State::Cooling(until) => {
                    limited += 1;
                    soonest = Some(soonest.map_or(until, |s| s.min(until)));
                    continue;
                }
                State::Dead => continue,
            }
            let handle = Handle {
                index: k.index,
                generation: k.generation,
            };
            return Ok((handle, Arc::clone(&k.secret)));
        }
        Err(match soonest {
            Some(next_at) => Unavailable::AllLimited { next_at, limited },
            None => Unavailable::AllDead,
        })
    }

    /// The provider answered 429 for this key. Moves it to the bottom with a cooldown. Returns false (and does
    /// nothing) when the handle is stale: another request already rotated this key.
    pub fn rate_limited(&mut self, h: Handle, retry_after: Option<Duration>, now: Instant) -> bool {
        let Some(pos) = self.keys.iter().position(|k| k.index == h.index) else {
            return false;
        };
        if self.keys[pos].generation != h.generation {
            return false;
        }
        let cooldown = retry_after
            .filter(|d| !d.is_zero())
            .unwrap_or(self.policy.default_cooldown)
            .clamp(self.policy.min_cooldown, self.policy.max_cooldown);
        let mut key = self.keys.remove(pos).expect("the position was just found");
        key.state = State::Cooling(now + cooldown);
        key.generation += 1;
        self.keys.push_front(key);
        true
    }

    /// The provider refused the key (401/403): revoked or invalid. Out for the life of the process.
    pub fn auth_failed(&mut self, h: Handle) {
        if let Some(k) = self.keys.iter_mut().find(|k| k.index == h.index) {
            k.state = State::Dead;
            k.generation += 1;
        }
    }

    /// Top to bottom, for `status`. No secrets.
    pub fn status(&self, now: Instant) -> Vec<KeyStatus> {
        self.keys
            .iter()
            .rev()
            .map(|k| match k.state {
                State::Dead => KeyStatus {
                    index: k.index,
                    state: "dead",
                    usable_in_s: None,
                },
                State::Cooling(until) if until > now => KeyStatus {
                    index: k.index,
                    state: "cooling",
                    usable_in_s: Some(until.saturating_duration_since(now).as_secs() + 1),
                },
                _ => KeyStatus {
                    index: k.index,
                    state: "ok",
                    usable_in_s: Some(0),
                },
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(n: usize) -> Pool {
        Pool::new(
            (0..n).map(|i| format!("secret-{i}")).collect(),
            Policy::default(),
        )
        .unwrap()
    }

    fn s(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    fn top(p: &mut Pool, now: Instant) -> usize {
        p.acquire(now).unwrap().0.index()
    }

    #[test]
    fn empty_pool_is_refused() {
        assert!(Pool::new(vec![], Policy::default()).is_none());
    }

    #[test]
    fn lifo_the_last_key_is_used_first_and_kept_while_healthy() {
        let mut p = pool(3);
        let now = Instant::now();
        assert_eq!(top(&mut p, now), 2);
        assert_eq!(top(&mut p, now), 2, "a healthy top key stays on top");
    }

    #[test]
    fn a_429_moves_the_key_to_the_bottom_and_the_next_one_is_used() {
        let mut p = pool(3);
        let now = Instant::now();
        let (h, _) = p.acquire(now).unwrap();
        assert!(p.rate_limited(h, Some(s(30)), now));
        assert_eq!(top(&mut p, now), 1);
        let order: Vec<usize> = p.status(now).iter().map(|k| k.index).collect();
        assert_eq!(order, vec![1, 0, 2], "key 2 went to the bottom");
        assert_eq!(p.len(), 3);
    }

    #[test]
    fn a_cooling_key_is_skipped_until_its_cooldown_ends() {
        let mut p = pool(2);
        let now = Instant::now();
        let (h, _) = p.acquire(now).unwrap(); // key 1
        p.rate_limited(h, Some(s(30)), now);
        assert_eq!(top(&mut p, now + s(29)), 0);
        // Key 0 limited too; at +31 the first key is back and, being usable, is picked from the top.
        let (h0, _) = p.acquire(now + s(29)).unwrap();
        p.rate_limited(h0, Some(s(600)), now + s(29));
        assert_eq!(top(&mut p, now + s(31)), 1);
    }

    #[test]
    fn all_limited_reports_the_soonest_time_and_how_many() {
        let mut p = pool(2);
        let now = Instant::now();
        let (h1, _) = p.acquire(now).unwrap();
        p.rate_limited(h1, Some(s(50)), now);
        let (h0, _) = p.acquire(now).unwrap();
        p.rate_limited(h0, Some(s(20)), now);
        match p.acquire(now) {
            Err(Unavailable::AllLimited { next_at, limited }) => {
                assert_eq!(next_at, now + s(20));
                assert_eq!(limited, 2);
            }
            other => panic!("expected AllLimited, got {other:?}"),
        }
    }

    #[test]
    fn an_auth_failure_sets_the_key_aside_for_good() {
        let mut p = pool(2);
        let now = Instant::now();
        let (h, _) = p.acquire(now).unwrap();
        p.auth_failed(h);
        for _ in 0..3 {
            assert_eq!(top(&mut p, now + s(100_000)), 0);
        }
        let dead = p.status(now).into_iter().find(|k| k.index == 1).unwrap();
        assert_eq!(dead.state, "dead");
    }

    #[test]
    fn all_dead_is_not_all_limited() {
        let mut p = pool(2);
        let now = Instant::now();
        for _ in 0..2 {
            let (h, _) = p.acquire(now).unwrap();
            p.auth_failed(h);
        }
        assert_eq!(p.acquire(now).unwrap_err(), Unavailable::AllDead);
    }

    #[test]
    fn a_pool_of_one_works_and_reports_all_limited_when_limited() {
        let mut p = pool(1);
        let now = Instant::now();
        let (h, _) = p.acquire(now).unwrap();
        p.rate_limited(h, Some(s(10)), now);
        assert!(matches!(
            p.acquire(now),
            Err(Unavailable::AllLimited { limited: 1, .. })
        ));
        assert_eq!(top(&mut p, now + s(11)), 0);
    }

    #[test]
    fn retry_after_missing_zero_and_huge_use_default_default_and_the_cap() {
        let policy = Policy {
            default_cooldown: s(60),
            min_cooldown: s(1),
            max_cooldown: s(3600),
        };
        for (given, expect) in [
            (None, 60),
            (Some(s(0)), 60),
            (Some(s(999_999)), 3600),
            (Some(s(5)), 5),
        ] {
            let mut p = Pool::new(vec!["a".into()], policy).unwrap();
            let now = Instant::now();
            let (h, _) = p.acquire(now).unwrap();
            p.rate_limited(h, given, now);
            let Err(Unavailable::AllLimited { next_at, .. }) = p.acquire(now) else {
                panic!("expected cooling");
            };
            assert_eq!(next_at, now + s(expect), "for {given:?}");
        }
    }

    #[test]
    fn a_stale_handle_does_not_rotate_a_key_twice() {
        let mut p = pool(3);
        let now = Instant::now();
        let (a, _) = p.acquire(now).unwrap();
        let (b, _) = p.acquire(now).unwrap(); // a concurrent request got the same key
        assert_eq!(a, b);
        assert!(p.rate_limited(a, Some(s(30)), now));
        assert!(!p.rate_limited(b, Some(s(30)), now), "already rotated");
        let order: Vec<usize> = p.status(now).iter().map(|k| k.index).collect();
        assert_eq!(order, vec![1, 0, 2]);
    }

    #[test]
    fn many_threads_never_lose_or_duplicate_a_key() {
        use std::sync::Mutex;
        let p = Arc::new(Mutex::new(pool(10)));
        let start = Instant::now();
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let p = Arc::clone(&p);
                std::thread::spawn(move || {
                    for i in 0..500u64 {
                        let now = start + Duration::from_millis(i);
                        let got = p.lock().unwrap().acquire(now);
                        if let Ok((h, _)) = got {
                            if (i + t) % 3 == 0 {
                                p.lock().unwrap().rate_limited(
                                    h,
                                    Some(Duration::from_millis(50)),
                                    now,
                                );
                            } else if (i + t) % 97 == 0 {
                                p.lock().unwrap().auth_failed(h);
                            }
                        }
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let g = p.lock().unwrap();
        let mut idx: Vec<usize> = g.status(start).iter().map(|k| k.index).collect();
        idx.sort_unstable();
        assert_eq!(idx, (0..10).collect::<Vec<_>>());
    }

    #[test]
    fn formatting_the_pool_or_its_status_never_shows_a_secret() {
        let mut p = Pool::new(vec!["sk-very-secret-value".into()], Policy::default()).unwrap();
        let now = Instant::now();
        let (handle, _) = p.acquire(now).unwrap();
        for shown in [
            format!("{p:?}"),
            format!("{:?}", p.status(now)),
            format!("{handle:?}"),
        ] {
            assert!(!shown.contains("very-secret"), "{shown}");
        }
    }
}
