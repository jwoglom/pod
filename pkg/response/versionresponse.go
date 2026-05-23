package response

import (
	"encoding/hex"

	"github.com/avereha/pod/pkg/pair"
)

// This is the special case - sent with the 0x0115 response to 0x07 message

// dashVersionResponseHex is the captured Dash byte stream returned by a real
// Dash pod for the GetVersion (0x07) command. Locking it as a named constant
// lets the regression test pin the exact bytes.
const dashVersionResponseHex = "0115040A00010300040208146DB10006E45100FFFFFFFF"

// o5VersionResponseHex is the Omnipod 5 byte stream for the same command.
// TODO(joe): replace with real O5 capture. Until then, we mirror the Dash
// bytes so behaviour is unchanged and the eventual swap is a one-line
// constant update.
const o5VersionResponseHex = dashVersionResponseHex

type VersionResponse struct {
	Seq uint16

	// Mode selects which captured byte stream Marshal returns. Zero value
	// (pair.ModeDash) preserves the legacy behaviour for any caller that
	// constructs this struct without setting it.
	Mode pair.Mode
}

func (r *VersionResponse) Marshal() ([]byte, error) {
	hexStr := dashVersionResponseHex
	if r.Mode == pair.ModeO5 {
		hexStr = o5VersionResponseHex
	}
	response, _ := hex.DecodeString(hexStr)

	return response, nil
}
