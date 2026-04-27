package bluetooth

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"hash/crc32"
	"strings"
	"sync"
	"time"

	"github.com/avereha/pod/pkg/bluetooth/packet"
	"github.com/avereha/pod/pkg/message"
	"github.com/davecgh/go-spew/spew"
	"github.com/paypal/gatt"
	"github.com/paypal/gatt/linux/cmd"
	log "github.com/sirupsen/logrus"
)

type Packet []byte

var (
	CmdRTS     = Packet([]byte{0})
	CmdCTS     = Packet([]byte{1})
	CmdNACK    = Packet([]byte{2, 0})
	CmdAbort   = Packet([]byte{3})
	CmdSuccess = Packet([]byte{4})
	CmdFail    = Packet([]byte{5})
)

type Ble struct {
	dataInput  chan Packet
	cmdInput   chan Packet
	// cmdActivation receives pairing-state command bytes (HELLO 0x06,
	// PAIR_STATUS 0x08, INCORRECT 0x09 — anything that isn't the RTS/CTS/
	// SUCCESS/NACK fragmentation control set). ReadCmd() drains this so
	// StartActivation gets first crack at the HELLO byte without racing
	// the message loop's cmdInput consumer.
	cmdActivation chan Packet
	dataOutput    chan Packet
	cmdOutput     chan Packet

	messageInput  chan *message.Message
	messageOutput chan *message.Message

	stopLoop chan bool
	device   *gatt.Device
	central  *gatt.Central

	cmdNotifier    gatt.Notifier
	cmdNotifierMtx sync.Mutex

	dataNotifier    gatt.Notifier
	dataNotifierMtx sync.Mutex

	heartbeatNotifier    gatt.Notifier
	heartbeatNotifierMtx sync.Mutex
}

var DefaultServerOptions = []gatt.Option{
	gatt.LnxMaxConnections(1),
	gatt.LnxDeviceID(-1, true),
	gatt.LnxSetAdvertisingParameters(&cmd.LESetAdvertisingParameters{
		AdvertisingIntervalMin: 0x00f4,
		AdvertisingIntervalMax: 0x00f4,
		AdvertisingChannelMap:  0x7,
	}),
}

func New(adapterID string, podId []byte) (*Ble, error) {
	d, err := gatt.NewDevice(DefaultServerOptions...)
	if err != nil {
		log.Fatalf("pkg bluetooth; failed to open device, err: %s", err)
	}

	b := &Ble{
		dataInput:     make(chan Packet, 5),
		cmdInput:      make(chan Packet, 5),
		cmdActivation: make(chan Packet, 5),
		dataOutput:    make(chan Packet, 5),
		cmdOutput:     make(chan Packet, 5),
		messageInput:  make(chan *message.Message, 5),
		messageOutput: make(chan *message.Message, 2),
		device:        &d,
	}

	d.Handle(
		gatt.CentralConnected(func(c gatt.Central) {
			fmt.Println("pkg bluetooth; ** New connection from: ", c.ID())
			// b.StopMessageLoop()
			b.central = &c
		}),
		gatt.CentralDisconnected(func(c gatt.Central) {
			log.Tracef("pkg bluetooth; ** disconnect: %s", c.ID())
		}),
	)

	// Start cmd writing goroutine
	go func() {
		for {
			packet := <-b.cmdOutput
			b.cmdNotifierMtx.Lock()
			if b.cmdNotifier.Done() {
				log.Fatalf("pkg bluetooth; CMD closed")
			}
			ret, err := b.cmdNotifier.Write(packet)
			b.cmdNotifierMtx.Unlock()
			log.Tracef("pkg bluetooth; CMD notification return: %d/%s", ret, hex.EncodeToString(packet))
			if err != nil {
				log.Fatalf("pkg bluetooth; error writing CMD: %s", err)
			}
		}
	}()

	// Start data writing goroutine
	go func() {
		for {
			packet := <-b.dataOutput
			b.dataNotifierMtx.Lock()
			if b.dataNotifier.Done() {
				log.Fatalf("pkg bluetooth; DATA closed")
			}
			ret, err := b.dataNotifier.Write(packet)
			b.dataNotifierMtx.Unlock()
			log.Tracef("pkg bluetooth; DATA notification return: %d/%s", ret, hex.EncodeToString(packet))
			if err != nil {
				log.Fatalf("pkg bluetooth; error writing DATA: %s ", err)
			}
		}
	}()

	// Heartbeat emitter: once a phone subscribes to the heartbeat
	// characteristic, push a one-byte notification every 10s. Real O5 pods
	// use this as a connection keep-alive.
	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for range t.C {
			b.heartbeatNotifierMtx.Lock()
			n := b.heartbeatNotifier
			b.heartbeatNotifierMtx.Unlock()
			if n == nil || n.Done() {
				continue
			}
			if _, err := n.Write([]byte{0x00}); err != nil {
				log.Tracef("pkg bluetooth; heartbeat write error: %s", err)
			}
		}
	}()

	// A mandatory handler for monitoring device state.
	onStateChanged := func(d gatt.Device, s gatt.State) {
		fmt.Printf("state: %s\n", s)
		switch s {
		case gatt.StatePoweredOn:
			// Main pod GATT service (Omnipod 5; same primary UUID as Dash).
			// Source: OmnipodKit BluetoothServices.swift / BlePodProfile.swift.
			var serviceUUID = gatt.MustParseUUID("1A7E4024-E3ED-4464-8B7E-751E03D0DC5F")
			var cmdCharUUID = gatt.MustParseUUID("1A7E2441-E3ED-4464-8B7E-751E03D0DC5F")
			var dataCharUUID = gatt.MustParseUUID("1A7E2443-E3ED-4464-8B7E-751E03D0DC5F")

			// Omnipod 5 heartbeat service used for keep-alive.
			// The pod GATT service UUID is 7DED7A6C... and its single
			// characteristic is 7DED7A6D... (notify). The ECF301E2... UUID
			// below is what OmnipodKit scans for in the advertisement, not a
			// GATT service exposed on the pod.
			var heartbeatServiceUUID = gatt.MustParseUUID("7DED7A6C-CA72-46A7-A3A2-6061F6FDCAEB")
			var heartbeatCharUUID = gatt.MustParseUUID("7DED7A6D-CA72-46A7-A3A2-6061F6FDCAEB")

			s := gatt.NewService(serviceUUID)

			cmdCharacteristic := s.AddCharacteristic(cmdCharUUID)
			cmdCharacteristic.HandleWriteFunc(
				func(r gatt.Request, data []byte) (status byte) {
					log.Tracef("pkg bluetooth; received CMD, %x -- %d", data, len(data))
					ret := make([]byte, len(data))
					copy(ret, data)
					// Multi-byte writes (e.g. HELLO = 06 01 04 + 4-byte
					// controller ID) and any non-RTS/SUCCESS single-byte
					// signal (HELLO, PAIR_STATUS, INCORRECT, …) belong on
					// the activation queue. RTS / SUCCESS / NACK / FAIL
					// stay on cmdInput where the message loop drains them
					// for fragmentation handshake and ack handling.
					if len(ret) > 1 || (ret[0] != CmdRTS[0] && ret[0] != CmdSuccess[0] &&
						ret[0] != CmdNACK[0] && ret[0] != CmdFail[0]) {
						b.cmdActivation <- Packet(ret)
					} else {
						b.cmdInput <- Packet(ret)
					}
					return 0
				})

			cmdCharacteristic.HandleNotifyFunc(
				func(r gatt.Request, n gatt.Notifier) {
					b.cmdNotifierMtx.Lock()
					b.cmdNotifier = n
					b.cmdNotifierMtx.Unlock()
					log.Infof("pkg bluetooth; handling CMD notifications on new connection from:  %s", r.Central.ID())
				})

			dataCharacteristic := s.AddCharacteristic(dataCharUUID)
			dataCharacteristic.HandleNotifyFunc(
				func(r gatt.Request, n gatt.Notifier) {
					b.dataNotifierMtx.Lock()
					b.dataNotifier = n
					b.dataNotifierMtx.Unlock()
					log.Infof("pkg bluetooth; handling DATA notifications on new connection from: %s", r.Central.ID())
					log.Infof("     *** OK to send commands from the phone app ***")
				})

			dataCharacteristic.HandleWriteFunc(
				func(r gatt.Request, data []byte) (status byte) {
					log.Tracef("pkg bluetooth; received DATA, %x -- %d", data, len(data))
					ret := make([]byte, len(data))
					copy(ret, data)
					b.dataInput <- Packet(ret)
					return 0
				})

			h := gatt.NewService(heartbeatServiceUUID)
			hbCharacteristic := h.AddCharacteristic(heartbeatCharUUID)
			hbCharacteristic.HandleNotifyFunc(
				func(r gatt.Request, n gatt.Notifier) {
					b.heartbeatNotifierMtx.Lock()
					b.heartbeatNotifier = n
					b.heartbeatNotifierMtx.Unlock()
					log.Infof("pkg bluetooth; handling heartbeat notifications on new connection from: %s", r.Central.ID())
				})

			err = d.SetServices([]*gatt.Service{s, h})
			if err != nil {
				log.Fatalf("pkg bluetooth; could not add service: %s", err)
			}

			podIdArray, err := hex.DecodeString("fffffffe")
			if err != nil {
				log.Fatalf("pkg bluetooth; could not parse default address: %s", err)
			}

			if podId != nil {
				podIdArray = podId
			}

			// CE1F923D-C539-48EA-7300-0AFFFFFFFE00 unpaired, or
			// CE1F923D-C539-48EA-7300-0A<pdmId>00 once paired. The
			// ECF301E2... UUID is OmnipodKit's "advertisement" identifier
			// for the O5 heartbeat service and is co-advertised so the
			// scanner can find it during discovery (BluetoothServices.swift).
			mfgData, _ := hex.DecodeString("60030001000000")
			err = d.AdvertiseNameServicesMfgData(
				"AP "+strings.ToUpper(hex.EncodeToString(podIdArray))+" 0A95B6110002761B",
				[]gatt.UUID{
					gatt.MustParseUUID("CE1F923D-C539-48EA-7300-0A" + hex.EncodeToString(podIdArray) + "00"),
					gatt.MustParseUUID("ECF301E2-674B-4474-94D0-364F3AA653E6"),
				},
				mfgData,
			)
			if err != nil {
				log.Fatalf("pkg bluetooth; could not advertise: %s", err)
			}
		default:
		}
	}
	err = d.Init(onStateChanged)
	if err != nil {
		log.Fatalf("pkg bluetooth; could not init bluetooth: %s", err)
	}
	return b, nil
}

func (b *Ble) RefreshAdvertisingWithSpecifiedId(id []byte) error { // 4 bytes, first 2 usually empty
	log.Debugf("RefreshAdvertisingWithSpecifiedId %x", id)
	// Looking at the paypal/gatt source code, we don't need to call StopAdvertising,
	// but just call AdvertiseNameAndServices and it should update

	mfgData, _ := hex.DecodeString("60030001000000")
	err := (*b.device).AdvertiseNameServicesMfgData(
		"AP "+strings.ToUpper(hex.EncodeToString(id))+" 0A95B6110002761B",
		[]gatt.UUID{
			gatt.MustParseUUID("CE1F923D-C539-48EA-7300-0A" + hex.EncodeToString(id) + "00"),
			gatt.MustParseUUID("ECF301E2-674B-4474-94D0-364F3AA653E6"),
		},
		mfgData,
	)
	if err != nil {
		log.Infof("pkg bluetooth; could not re-advertise: %s", err)
	}
	return err
}

func (b *Ble) WriteCmd(packet Packet) error {

	b.cmdOutput <- packet
	return nil
}

func (b *Ble) WriteData(packet Packet) error {
	b.dataOutput <- packet
	return nil
}

func (b *Ble) writeDataBuffer(buf *bytes.Buffer) error {
	data := make([]byte, buf.Len())
	copy(data, buf.Bytes())
	buf.Reset()
	return b.WriteData(data)
}

// ReadCmd blocks until the next pairing-state command byte arrives on the
// CMD characteristic — typically the OmnipodKit HELLO frame
// (06 01 04 + 4-byte controller ID). RTS/CTS/SUCCESS/NACK/FAIL signal bytes
// are not delivered here; they are consumed inline by the message loop's
// readMessage path.
func (b *Ble) ReadCmd() (Packet, error) {
	packet := <-b.cmdActivation
	return packet, nil
}

func (b *Ble) ReadData() (Packet, error) {
	packet := <-b.dataInput
	return packet, nil
}

func (p Packet) String() string {
	return hex.EncodeToString(p)
}

func (b *Ble) ReadMessage() (*message.Message, error) {
	message := <-b.messageInput
	return message, nil
}

func (b *Ble) ReadMessageWithTimeout(d time.Duration) (*message.Message, bool) {
	select {
	case message := <-b.messageInput:
		return message, false
	case <-time.After(d):
		log.Debugf("ReadMessage timeout")
		return nil, true
	}
}

func (b *Ble) ShutdownConnection() {
	(*b.central).Close()
}

func (b *Ble) WriteMessage(message *message.Message) {
	b.messageOutput <- message
}

func (b *Ble) loop(stop chan bool) {
	for {
		select {
		case <-stop:
			return
		case msg := <-b.messageOutput:
			b.writeMessageData(msg)
		case data := <-b.dataInput:
			msg, err := b.readMessageData(data)
			if err != nil {
				log.Fatalf("pkg bluetooth; error reading message: %s", err)
			}
			b.messageInput <- msg
		case cmd := <-b.cmdInput:
			msg, err := b.readMessage(cmd)
			if err != nil {
				log.Fatalf("pkg bluetooth; error reading message: %s", err)
			}
			if msg != nil {
				b.messageInput <- msg
			}
		}
	}
}

func (b *Ble) StartMessageLoop() {
	if b.stopLoop != nil {
		log.Fatalf("pkg bluetooth; Messaging loop is already running")
	}
	b.stopLoop = make(chan bool)
	go b.loop(b.stopLoop)
}

func (b *Ble) StopMessageLoop() {
	// race condition, but this is called only on device disconnect
	if b.stopLoop != nil {
		close(b.stopLoop)
		b.stopLoop = nil
	}
}

func (b *Ble) expectCommand(expected Packet) {
	cmd, _ := b.ReadCmd()
	if !bytes.Equal(expected[:1], cmd[:1]) {
		log.Fatalf("pkg bluetooth; expected command: %s. received command: %s", expected, cmd)
	}
}

func (b *Ble) writeMessageData(msg *message.Message) {
	payload, err := msg.Marshal()
	if err != nil {
		log.Fatalf("pkg bluetooth; could not marshal the message %s", err)
	}
	log.Debugf("pkg bluetooth; sending message (%d bytes): %x", len(payload), payload)

	packets := packet.Split(payload)
	log.Debugf("pkg bluetooth; split into %d BLE fragment(s)", len(packets))

	for i, pkt := range packets {
		log.Tracef("pkg bluetooth; writing fragment %d/%d (%d bytes)", i+1, len(packets), len(pkt))
		var buf bytes.Buffer
		buf.Write(pkt)
		b.writeDataBuffer(&buf)
	}
}

func (b *Ble) writeMessage(msg *message.Message) {
	var buf bytes.Buffer
	var index byte = 0

	b.WriteCmd(CmdRTS)
	b.expectCommand(CmdCTS) // TODO figure out what to do if !CTS
	bytes, err := msg.Marshal()
	if err != nil {
		log.Fatalf("pkg bluetooth; could not marshal the message %s", err)
	}
	log.Tracef("pkg bluetooth; Sending message: %x", bytes)
	sum := crc32.ChecksumIEEE(bytes)
	if len(bytes) <= 18 {
		buf.WriteByte(index) // index
		buf.WriteByte(0)     // fragments

		buf.WriteByte(byte(sum >> 24))
		buf.WriteByte(byte(sum >> 16))
		buf.WriteByte(byte(sum >> 8))
		buf.WriteByte(byte(sum))
		buf.WriteByte((byte(len(bytes))))
		end := len(bytes)
		if len(bytes) > 14 {
			end = 14
		}
		buf.Write(bytes[:end])
		b.writeDataBuffer(&buf)

		if len(bytes) > 14 {
			buf.WriteByte(index)
			buf.WriteByte(byte(len(bytes) - 14))
			buf.Write(bytes[14:])
			b.writeDataBuffer(&buf)
		}
		return
	}

	size := len(bytes)
	fullFragments := (byte)((size - 18) / 19)
	rest := (byte)((size - (int(fullFragments) * 19)) - 18)
	buf.WriteByte(index)
	buf.WriteByte(fullFragments + 1)
	buf.Write(bytes[:18])

	b.writeDataBuffer(&buf)

	for index = 1; index <= fullFragments; index++ {
		buf.WriteByte(index)
		if index == 1 {
			buf.Write(bytes[18:37])
		} else {
			buf.Write(bytes[(index-1)*19+18 : (index-1)*19+18+19])
		}
		b.writeDataBuffer(&buf)
	}

	buf.WriteByte(index)
	buf.WriteByte(rest)
	buf.WriteByte(byte(sum >> 24))
	buf.WriteByte(byte(sum >> 16))
	buf.WriteByte(byte(sum >> 8))
	buf.WriteByte(byte(sum))
	end := rest
	if rest > 14 {
		end = 14
	}
	buf.Write(bytes[(fullFragments*19)+18 : (fullFragments*19)+18+end])
	b.writeDataBuffer(&buf)
	if rest > 14 {
		index++
		buf.WriteByte(index)
		buf.WriteByte(rest - 14)
		buf.Write(bytes[fullFragments*19+18+14:])
		for buf.Len() < 20 {
			buf.WriteByte(0)
		}
		b.writeDataBuffer(&buf)
	}
	b.expectCommand(CmdSuccess)
}

func (b *Ble) readMessageData(data Packet) (*message.Message, error) {
	return b.parsePackets(data)
}

func (b *Ble) parsePackets(first Packet) (*message.Message, error) {
	log.Debugf("pkg bluetooth; reassembling, first fragment %d bytes: %x", len(first), first)
	bytesOut, err := packet.Join(first, func() ([]byte, error) {
		pkt, e := b.ReadData()
		if e == nil {
			log.Tracef("pkg bluetooth; got next fragment %d bytes: %x", len(pkt), []byte(pkt))
		}
		return pkt, e
	})
	if err != nil {
		log.Warnf("pkg bluetooth; reassembly failed: %s", err)
		b.WriteCmd(CmdFail)
		return nil, err
	}
	log.Debugf("pkg bluetooth; reassembled %d-byte message", len(bytesOut))

	b.WriteCmd(CmdSuccess)

	msg, mErr := message.Unmarshal(bytesOut)
	log.Tracef("pkg bluetooth; received message: %s", spew.Sdump(msg))
	return msg, mErr
}

func (b *Ble) readMessage(cmd Packet) (*message.Message, error) {

	if bytes.Equal(CmdSuccess[:1], cmd[:1]) {
		return nil, nil
	}

	if !bytes.Equal(CmdRTS[:1], cmd[:1]) {
		// HELLO / PAIR_STATUS / etc. are routed to cmdActivation by the
		// CMD char write handler, so seeing one here means it slipped
		// through the dispatcher (e.g. a multi-byte signal misclassified).
		// Log and ignore rather than fatal — the activation-path consumer
		// (StartActivation's ReadCmd) will pick it up if relevant.
		log.Warnf("pkg bluetooth; readMessage saw unexpected cmd byte 0x%02x; ignoring", cmd[0])
		return nil, nil
	}
	log.Trace("pkg bluetooth; Reading RTS, sending CTS")

	b.WriteCmd(CmdCTS)

	first, _ := b.ReadData()
	return b.parsePackets(first)
}
