package response

import (
	"encoding/hex"
	"testing"

	"github.com/avereha/pod/pkg/pair"
)

// TestVersionResponseMarshalDash pins the Dash mode byte stream so any
// unintended change to the response is caught by CI. This is the exact hex
// captured from a real Dash pod.
func TestVersionResponseMarshalDash(t *testing.T) {
	const want = "0115040A00010300040208146DB10006E45100FFFFFFFF"

	r := &VersionResponse{Mode: pair.ModeDash}
	got, err := r.Marshal()
	if err != nil {
		t.Fatalf("Marshal returned error: %v", err)
	}
	if hex.EncodeToString(got) != hexLower(want) {
		t.Fatalf("Dash VersionResponse bytes mismatch:\n got=%x\nwant=%s", got, hexLower(want))
	}
}

// TestVersionResponseMarshalZeroValueIsDash ensures legacy callers that
// construct &VersionResponse{} without setting Mode keep getting Dash bytes.
func TestVersionResponseMarshalZeroValueIsDash(t *testing.T) {
	const want = "0115040A00010300040208146DB10006E45100FFFFFFFF"

	r := &VersionResponse{}
	got, err := r.Marshal()
	if err != nil {
		t.Fatalf("Marshal returned error: %v", err)
	}
	if hex.EncodeToString(got) != hexLower(want) {
		t.Fatalf("zero-value VersionResponse bytes mismatch:\n got=%x\nwant=%s", got, hexLower(want))
	}
}

// TestVersionResponseMarshalO5 pins the Omnipod 5 mode byte stream. Today this
// equals the Dash bytes because Joe's real O5 capture hasn't landed yet.
// TODO(joe): once o5VersionResponseHex diverges from the Dash constant,
// update `want` here to the real O5 hex so the regression guard tracks it.
func TestVersionResponseMarshalO5(t *testing.T) {
	const want = "0115040A00010300040208146DB10006E45100FFFFFFFF"

	r := &VersionResponse{Mode: pair.ModeO5}
	got, err := r.Marshal()
	if err != nil {
		t.Fatalf("Marshal returned error: %v", err)
	}
	if hex.EncodeToString(got) != hexLower(want) {
		t.Fatalf("O5 VersionResponse bytes mismatch:\n got=%x\nwant=%s", got, hexLower(want))
	}
}
