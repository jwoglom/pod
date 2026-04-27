package packet

import (
	"bytes"
	"testing"
)

// TestPacketRoundTrip exercises split→join across the size regimes that
// exercise different code paths: a tiny payload (single packet), a payload
// that just barely overflows a single packet (single + LastOptionalPlusOne),
// a multi-fragment payload that fits cleanly in last, and a large payload
// that needs the LastOptionalPlusOne tail.
func TestPacketRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		size int
	}{
		{"tiny", 16},
		{"single-cap", firstPacketCapacityWithoutMiddle()},
		{"single+extra", firstPacketCapacityWithoutMiddle() + 5},
		{"two-frag", firstPacketCapacityWithMiddle() + 50},
		{"three-frag-clean", firstPacketCapacityWithMiddle() + middlePacketCapacity() + 50},
		{"three-frag-extra", firstPacketCapacityWithMiddle() + middlePacketCapacity() + lastPacketCapacity() + 17},
		{"sps2.1-sized", 666},
		{"sps2-sized", 920},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := make([]byte, tc.size)
			for i := range payload {
				payload[i] = byte(i)
			}
			packets := Split(payload)
			if len(packets) == 0 {
				t.Fatal("splitPayload returned no packets")
			}
			for _, p := range packets {
				if len(p) > MaxPayloadSize {
					t.Errorf("packet larger than MTU: %d", len(p))
				}
			}

			i := 0
			out, err := Join(packets[0], func() ([]byte, error) {
				i++
				if i >= len(packets) {
					t.Fatalf("joiner asked for fragment %d but only %d available", i, len(packets))
				}
				return packets[i], nil
			})
			if err != nil {
				t.Fatalf("joinPackets: %v", err)
			}
			if !bytes.Equal(out, payload) {
				t.Errorf("round-trip mismatch: got %d bytes, want %d", len(out), len(payload))
			}
		})
	}
}

// TestPacketCRCDetectsTamper confirms the joiner rejects a flipped byte.
func TestPacketCRCDetectsTamper(t *testing.T) {
	payload := make([]byte, 500)
	for i := range payload {
		payload[i] = byte(i)
	}
	packets := Split(payload)
	// Flip a byte in the middle of fragment 0's payload area (after the
	// 2-byte header, before any structural byte the joiner reads).
	packets[0][50] ^= 0xff

	i := 0
	_, err := Join(packets[0], func() ([]byte, error) {
		i++
		return packets[i], nil
	})
	if err == nil {
		t.Fatal("expected CRC mismatch error after tamper")
	}
}
