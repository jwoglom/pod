package eap

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/wmnsk/milenage"
)

func TestEapAka_MarshalUnmarshal(t *testing.T) {
	tests := []struct {
		name string
		eap  *EapAka
	}{
		{
			name: "emtpy",
			eap:  &EapAka{},
		},
		{
			name: "success",
			eap: &EapAka{
				Code: CodeSuccess,
			},
		},
		{
			name: "challenge",
			eap: &EapAka{
				Code:    CodeRequest,
				SubType: SubTypeAkaChallenge,
				Attributes: map[AttributeType]*Attribute{
					AT_RAND: {
						Data: make([]byte, 16),
					},
					AT_CUSTOM_IV: {
						Data: make([]byte, 4),
					},
					AT_AUTN: {
						Data: make([]byte, 16),
					},
				},
			},
		},
		{
			name: "response",
			eap: &EapAka{
				Code:    CodeResponse,
				SubType: SubTypeAkaChallenge,
				Attributes: map[AttributeType]*Attribute{
					AT_RES: {
						Data: make([]byte, 8),
					},
					AT_CUSTOM_IV: {
						Data: make([]byte, 4),
					},
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tt.eap.Marshal()
			if err != nil {
				t.Errorf("EapAka.Marshal() error = %v", err)
				return
			}

			back, err := Unmarshal(got)
			if err != nil {
				t.Error(err)
			}
			if diff := cmp.Diff(tt.eap, back); diff != "" {
				t.Errorf("EapAka.Unmarshal() mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

// The AUTN OmnipodKit sent when pairing with the simulator, whose SQN (1)
// is one behind the pod's own (2): the MAC-A is checked over the phone's.
func TestEapAkaChallenge_PhoneMACA(t *testing.T) {
	unhex := func(s string) []byte {
		b, err := hex.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	e := &EapAkaChallenge{
		k:    unhex("6c04db96dba94827bfb5e23d821552f2"),
		op:   unhex("cdc202d5123e20f62b6d676ac72cb318"),
		rand: unhex("d4e5514ae04b0016b4fdeeab719b800f"),
		autn: unhex("81590495535eb9b9e21e56a91fa03fcf"),
		amf:  0xb9b9,
		Sqn:  2,
	}
	_, _, _, ak, err := milenage.New(e.k, e.op, e.rand, e.Sqn, e.amf).F2345()
	if err != nil {
		t.Fatal(err)
	}
	sqn, maca, err := e.phoneMACA(ak)
	if err != nil {
		t.Fatal(err)
	}
	if sqn != 1 {
		t.Errorf("phone SQN = %d, want 1", sqn)
	}
	if !bytes.Equal(maca, e.autn[8:]) {
		t.Errorf("MAC-A = %x, want the AUTN's %x", maca, e.autn[8:])
	}
}
