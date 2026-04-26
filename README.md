# pod

Fake pod implementation. Originally a Dash simulator; now defaults to **Omnipod 5** mode.

* The original 0pen-dash repository from which this was forked was removed by the owner.

* This fork has diverged much from the structure of the previous implementation, which was based on hardcoded responses. This version attempts to have a state the mimics more pod details like reservoir level, total delivery, alerts, and faults, and builds dynamic responses based on that state.

* This version also mimics a behavior we see in real pods where the pod disconnects every 3 minutes; this can be used with iOS hooks to make a heartbeat to run Loop in situations where a BLE CGM is not available.

* It also has a websocket based API that can used by a separate [NodeJS/React frontend](https://github.com/ps2/pod_simulator_frontend), that is installed an run separately for now.

Requirements:
1. Version of iOS code that handles this - under development - not ready for others to use
2. Raspberry pi with Bluetooth BLE (using a pi4 right now)
3. The user must have sudo privilege on the pi
4. Install the go language on your device (search internet for procedure)
  *  You can build on pi directly or use cross-compiler and scp the executable

## Build on the pi

Log on the pi and type the following commands, starting at {your_path}/pod:
```
go build
sudo setcap 'cap_net_raw,cap_net_admin=eip' ./pod
```

## Run simulator on the pi

The simulator runs until
* aborted with a control-C
* pod is deactivated on the phone
* quit out of phone app after establishing BLE connection

The simulator may error out unexpectedly. Just restart it and it should reconnect with the app (do not use the `-fresh` flag in this case.)

When in doubt, control-C and restart it.

To pair a new simulated dash pod:
```
./pod -fresh -q
```

Wait until getting this notification before attempting to pair with the app:
```
enabled notifications for CMD:
enabled notifications for DATA:
*** OK to send commands from the phone app ***
```

To restore communication with an existing simulated dash pod and wait for the messages shown above:
```
./pod -q
```

To change the reporting level, add one of these two flags:
* `-v` to make reporting more verbose (Trace Level)
* `-q` to make reporting less verbose (recommended)
* no extra flag - medium verbose (Debug Level)

Note that quitting the app will cause the following message:
```
FATA[####] pkg bluetooth; ** disconnect:
```

Simple restore communication as stated above.

## Omnipod 5 mode

`-mode o5` (the default) targets the Omnipod 5 BLE protocol. The pieces that differ from Dash are documented in [DASH_VS_O5_PROTOCOL.md](DASH_VS_O5_PROTOCOL.md). Highlights:

* P-256 ECDH for pairing, with a SHA-256 KDF over a length-prefixed buffer that mixes a fixed `FIRMWARE_ID` with the public keys and shared secret.
* SPS2.1/SPS2 carry AES-CCM-encrypted X.509 certs (SPS2 also carries a 64-byte ECDSA signature). The simulator generates a self-signed P-256 cert + key on first activation and persists it in `state.toml`.
* The 9 O5 AID setup commands (UTC, TDI, target BG profile, DIA, EGV, insulin history ×3, AID pod-status, plus alert/bolus follow-ups) run between AssignAddress and SetupPod using OmnipodKit's plain-ASCII key=value protocol.
* `programBolus(prime/cannula-insert)` and `programBasal` arrive as Type-4 (`ENCRYPTED_SIGNED`) frames; the simulator verifies the controller's ECDSA signature using the PDM TLS pubkey extracted from SPS2.

### Smoke-testing against OmnipodKit

The intended test target is a build of `OmnipodKit` (sibling repo at `../OmnipodKit`) on a real iPhone driving pod-five over BLE. OmnipodKit's pod-side cert / signature checks are soft-fail and there is no chain validation, so no patching is required to accept the simulator's synthetic identity — OmnipodKit just needs its own `O5RegistrationData` populated.

OmnipodKit features that are not on the simulator's compatibility path (and that the stock Insulet iOS app does use) include L2CAP CoC switchover post-pairing and pod-initiated unsolicited commands; pod-five doesn't emit either, which is fine because OmnipodKit doesn't expect them.

# Original README.md

We maintained the original README file below. It may be helpful if someone plans to cross-compile the code and just transfer the executable.

The "scripts" folder contains bits and small pieces that I [original owner] used trying to figure out the protocol with data from logs.

## How to build

```
go build
```

building for Raspberry Pi:
```
GOARCH=arm go build`
```

## How to run

This was tested so far only on Linux.
Before running, bring the BLE device down and stop bluetooth daemon
```
sudo hciconfig
sudo hciconfig hci0 down

sudo service bluetooth stop
sudo  systemctl  disable bluetooth
```

Before running, the executable must be granted capabilities(or run as root):
```
sudo setcap 'cap_net_raw,cap_net_admin=eip' ./pod
```
And then run

```
./pod -fresh
```

## Flags

```
$ ./pod  --help
Usage of ./pod:
  -fresh
        start fresh. not activated, empty state
  -mode string
        pairing mode: dash or o5 (default "o5")
  -state string
        pod state (default "state.toml")

```

When running with `-fresh`, the state will be saved, so running it twice(first with `-fresh`, then without) should work.

## How to build & run for Raspberry pi
Tested on `Raspberry Pi 3B+` running `Raspbian 10`

```
GOARCH=arm go build;
ssh pi 'killall pod';
scp pod pi:~/  
ssh pi " sudo setcap 'cap_net_raw,cap_net_admin=eip' ./pod; ./pod"
```
