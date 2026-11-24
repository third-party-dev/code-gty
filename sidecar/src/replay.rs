//! Bounded buffer of the most recent raw output of a session.

use std::collections::VecDeque;

pub struct Replay {
    buf: VecDeque<u8>,
    limit: usize,
    /// Total bytes ever dropped from the front, so callers can tell whether
    /// the replay is complete.
    dropped: u64,
}

impl Replay {
    pub fn new(limit: usize) -> Self {
        Replay { buf: VecDeque::with_capacity(limit.min(64 * 1024)), limit, dropped: 0 }
    }

    pub fn push(&mut self, data: &[u8]) {
        if self.limit == 0 {
            self.dropped += data.len() as u64;
            return;
        }
        if data.len() >= self.limit {
            self.dropped += (self.buf.len() + data.len() - self.limit) as u64;
            self.buf.clear();
            self.buf.extend(&data[data.len() - self.limit..]);
            return;
        }
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.limit);
        if overflow > 0 {
            self.buf.drain(..overflow);
            self.dropped += overflow as u64;
        }
        self.buf.extend(data);
    }

    pub fn snapshot(&self) -> Vec<u8> {
        let (a, b) = self.buf.as_slices();
        let mut out = Vec::with_capacity(a.len() + b.len());
        out.extend_from_slice(a);
        out.extend_from_slice(b);
        out
    }

    pub fn truncated(&self) -> bool {
        self.dropped > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_tail() {
        let mut r = Replay::new(5);
        r.push(b"abc");
        r.push(b"def");
        assert_eq!(r.snapshot(), b"bcdef");
        assert!(r.truncated());
        r.push(b"0123456789");
        assert_eq!(r.snapshot(), b"56789");
    }

    #[test]
    fn under_limit() {
        let mut r = Replay::new(100);
        r.push(b"abc");
        assert_eq!(r.snapshot(), b"abc");
        assert!(!r.truncated());
    }

    #[test]
    fn zero_limit() {
        let mut r = Replay::new(0);
        r.push(b"abc");
        assert!(r.snapshot().is_empty());
    }
}
