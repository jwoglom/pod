// Package delivery contains pure helpers for computing in-flight bolus
// progress. It deliberately has no external imports beyond `time` so it can
// be unit-tested on any platform (the parent `pod` package imports BLE
// libraries that are Linux-only).
package delivery

import "time"

// PartialPulses returns the number of pulses delivered between start and now,
// capped at total. Each pulse takes 2 seconds, matching real Omnipod 5
// behaviour.
func PartialPulses(total uint16, start, now time.Time) uint16 {
	if start.IsZero() || total == 0 {
		return 0
	}
	elapsed := now.Sub(start)
	if elapsed <= 0 {
		return 0
	}
	delivered := elapsed / (2 * time.Second)
	if delivered >= time.Duration(total) {
		return total
	}
	return uint16(delivered)
}
