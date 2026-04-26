package delivery

import (
	"testing"
	"time"
)

func TestPartialPulses(t *testing.T) {
	start := time.Date(2026, 4, 26, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		name  string
		total uint16
		now   time.Time
		want  uint16
	}{
		{"before start", 10, start.Add(-time.Second), 0},
		{"at start", 10, start, 0},
		{"one pulse in", 10, start.Add(2 * time.Second), 1},
		{"five pulses in", 10, start.Add(10 * time.Second), 5},
		{"exactly done", 10, start.Add(20 * time.Second), 10},
		{"past end clamps", 10, start.Add(time.Hour), 10},
		{"zero pulses", 0, start.Add(time.Second), 0},
		{"zero start", 5, time.Time{}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var startUsed time.Time
			if tc.name == "zero start" {
				startUsed = time.Time{}
			} else {
				startUsed = start
			}
			if got := PartialPulses(tc.total, startUsed, tc.now); got != tc.want {
				t.Errorf("PartialPulses(%d, …) = %d, want %d", tc.total, got, tc.want)
			}
		})
	}
}
