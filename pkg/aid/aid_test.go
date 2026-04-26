package aid

import (
	"bytes"
	"testing"
)

func TestIsAIDPayload(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		want bool
	}{
		{"standard SLPE", []byte{'S', '0', '.', '0', '=', 0x00, 0x10}, false},
		{"AID SET+GET", []byte("S3.2=hello,G3.2"), true},
		{"AID GET", []byte("G3.11"), true},
		{"AID Extended SET", []byte("SE255.2=12345"), true},
		{"AID GET 3.12", []byte("G3.12"), true},
		{"too short", []byte{'S'}, false},
		{"random bytes", []byte{0x01, 0x02, 0x03, 0x04}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsAIDPayload(tc.data); got != tc.want {
				t.Errorf("IsAIDPayload(%q) = %v, want %v", tc.data, got, tc.want)
			}
		})
	}
}

func TestParseSetGet_ASCII(t *testing.T) {
	c, err := Parse([]byte("S3.9=8,G3.9"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Kind != KindSetGet || c.Feature != "3" || c.Attribute != "9" || string(c.Data) != "8" {
		t.Fatalf("got %+v / %q", c, string(c.Data))
	}
}

func TestParseSetGet_Binary(t *testing.T) {
	bin := []byte{0x00, 0x03, 0x00, 0x0E, 0x00}
	payload := []byte("S3.2=")
	payload = append(payload, bin...)
	payload = append(payload, []byte(",G3.2")...)
	c, err := Parse(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(c.Data, bin) {
		t.Fatalf("data mismatch: %x vs %x", c.Data, bin)
	}
}

func TestParseSetGet_BinaryWithEmbeddedComma(t *testing.T) {
	// Binary blob can contain commas; the trailing ",G3.2" suffix is
	// length-anchored, not value-anchored.
	bin := []byte{0x00, ',', 'G', 0x03, ',', 'X'}
	payload := []byte("S3.2=")
	payload = append(payload, bin...)
	payload = append(payload, []byte(",G3.2")...)
	c, err := Parse(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(c.Data, bin) {
		t.Fatalf("data mismatch: %x vs %x", c.Data, bin)
	}
}

func TestParseGet(t *testing.T) {
	c, err := Parse([]byte("G3.11"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Kind != KindGet || c.Feature != "3" || c.Attribute != "11" {
		t.Fatalf("got %+v", c)
	}
	if len(c.Data) != 0 {
		t.Errorf("GET should have empty Data")
	}
}

func TestParseExtSet(t *testing.T) {
	c, err := Parse([]byte("SE255.2=1234567890"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Kind != KindExtSet || c.Feature != "255" || c.Attribute != "2" {
		t.Fatalf("got %+v", c)
	}
	if string(c.Data) != "1234567890" {
		t.Errorf("data = %q", string(c.Data))
	}
}

func TestEncodeRoundTrip(t *testing.T) {
	for _, tc := range [][]byte{
		[]byte("S3.9=8,G3.9"),
		[]byte("G3.12"),
		[]byte("SE255.2=1700000000"),
	} {
		c, err := Parse(tc)
		if err != nil {
			t.Fatal(err)
		}
		got := c.Encode()
		if !bytes.Equal(got, tc) {
			t.Errorf("round-trip mismatch:\n have: %q\n want: %q", got, tc)
		}
	}
}

func TestBuildResponse(t *testing.T) {
	cases := []struct {
		in       []byte
		wantHead string
	}{
		{[]byte("SE255.2=1700000000"), "ES255.2=0"},
		{[]byte("S3.9=8,G3.9"), "3.9=8"},
		{[]byte("G3.12"), "3.12="},
	}
	for _, tc := range cases {
		c, err := Parse(tc.in)
		if err != nil {
			t.Fatal(err)
		}
		resp := c.BuildResponse()
		if !bytes.HasPrefix(resp, []byte(tc.wantHead)) {
			t.Errorf("response %q should start with %q", resp, tc.wantHead)
		}
	}
}

func TestBuildResponseSetGetEchoesBinary(t *testing.T) {
	bin := []byte{0xDE, 0xAD, 0xBE, 0xEF, 0x00}
	payload := []byte("S3.2=")
	payload = append(payload, bin...)
	payload = append(payload, []byte(",G3.2")...)
	c, err := Parse(payload)
	if err != nil {
		t.Fatal(err)
	}
	resp := c.BuildResponse()
	want := []byte("3.2=")
	want = append(want, bin...)
	if !bytes.Equal(resp, want) {
		t.Errorf("expected echo, got %x", resp)
	}
}
