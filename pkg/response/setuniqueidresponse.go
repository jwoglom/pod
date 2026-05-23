package response

import (
	"encoding/hex"

	"github.com/avereha/pod/pkg/pair"
)

// This is the special case - sent with the 0x011B response to 0x03 message

// dashSetUniqueIDResponseHex is the captured Dash byte stream returned by a
// real Dash pod for the SetUniqueID (0x03) command. Locking it as a named
// constant lets the regression test pin the exact bytes.
const dashSetUniqueIDResponseHex = "011B13881008340A50040A00010300040308146DB10006E45100001091"

// o5SetUniqueIDResponseHex is the Omnipod 5 byte stream for the same command.
// TODO(joe): replace with real O5 capture. Until then, we mirror the Dash bytes
// so behaviour is unchanged and the eventual swap is a one-line constant
// update.
const o5SetUniqueIDResponseHex = dashSetUniqueIDResponseHex

type SetUniqueID struct {
	Seq uint16

	// Mode selects which captured byte stream Marshal returns. Zero value
	// (pair.ModeDash) preserves the legacy behaviour for any caller that
	// constructs this struct without setting it.
	Mode pair.Mode
}

func (r *SetUniqueID) Marshal() ([]byte, error) {
	hexStr := dashSetUniqueIDResponseHex
	if r.Mode == pair.ModeO5 {
		hexStr = o5SetUniqueIDResponseHex
	}
	response, _ := hex.DecodeString(hexStr)

	return response, nil
}
