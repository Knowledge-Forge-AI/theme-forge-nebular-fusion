use std::collections::{BTreeSet, VecDeque};

const HISTORY_BOUND: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IncomingId {
    Current,
    Retired,
    Completed,
    Unknown,
}

#[derive(Debug, Default)]
pub(crate) struct RequestCoordinator {
    active: Option<u64>,
    completed_order: VecDeque<u64>,
    completed: BTreeSet<u64>,
    retired_order: VecDeque<u64>,
    retired: BTreeSet<u64>,
}

impl RequestCoordinator {
    pub(crate) fn begin(&mut self, id: u64) -> Result<(), ()> {
        if id == 0
            || self.active.is_some()
            || self.completed.contains(&id)
            || self.retired.contains(&id)
        {
            return Err(());
        }
        self.active = Some(id);
        Ok(())
    }

    pub(crate) fn abandon(&mut self, id: u64) {
        if self.active == Some(id) {
            self.active = None;
        }
    }

    pub(crate) fn complete(&mut self, id: u64) -> Result<(), ()> {
        if self.active != Some(id) {
            return Err(());
        }
        self.active = None;
        Self::insert_bounded(id, &mut self.completed_order, &mut self.completed);
        Ok(())
    }

    pub(crate) fn retire_timeout(&mut self, id: u64) -> Result<(), ()> {
        if self.active != Some(id) {
            return Err(());
        }
        self.active = None;
        Self::insert_bounded(id, &mut self.retired_order, &mut self.retired);
        Ok(())
    }

    pub(crate) fn classify(&self, id: u64) -> IncomingId {
        if self.active == Some(id) {
            IncomingId::Current
        } else if self.retired.contains(&id) {
            IncomingId::Retired
        } else if self.completed.contains(&id) {
            IncomingId::Completed
        } else {
            IncomingId::Unknown
        }
    }

    pub(crate) fn is_bounded(&self) -> bool {
        self.retired.len() <= HISTORY_BOUND
            && self.completed.len() <= HISTORY_BOUND
            && self.active.iter().count() <= 1
    }

    fn insert_bounded(id: u64, order: &mut VecDeque<u64>, set: &mut BTreeSet<u64>) {
        order.push_back(id);
        set.insert(id);
        while order.len() > HISTORY_BOUND {
            if let Some(expired) = order.pop_front() {
                set.remove(&expired);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{HISTORY_BOUND, IncomingId, RequestCoordinator};

    #[test]
    fn timeout_retirement_is_bounded_and_late_data_is_distinct_from_unknown() {
        let mut coordinator = RequestCoordinator::default();
        for id in 1..=(HISTORY_BOUND as u64 * 3) {
            assert_eq!(coordinator.begin(id), Ok(()));
            assert_eq!(coordinator.retire_timeout(id), Ok(()));
            assert!(coordinator.is_bounded());
        }
        assert_eq!(coordinator.classify(1), IncomingId::Unknown);
        assert_eq!(
            coordinator.classify(HISTORY_BOUND as u64 * 3),
            IncomingId::Retired
        );
        assert_eq!(
            coordinator.classify(HISTORY_BOUND as u64 * 3 + 1),
            IncomingId::Unknown
        );
    }

    #[test]
    fn completed_duplicate_and_current_request_cannot_cross_satisfy() {
        let mut coordinator = RequestCoordinator::default();
        assert_eq!(coordinator.begin(7), Ok(()));
        assert_eq!(coordinator.classify(8), IncomingId::Unknown);
        assert_eq!(coordinator.classify(7), IncomingId::Current);
        assert_eq!(coordinator.complete(7), Ok(()));
        assert_eq!(coordinator.classify(7), IncomingId::Completed);
        assert_eq!(coordinator.begin(8), Ok(()));
        assert_eq!(coordinator.classify(7), IncomingId::Completed);
        assert_eq!(coordinator.classify(8), IncomingId::Current);
    }
}
