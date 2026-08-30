# Where the backend runs

Short answer: hosted, with a public name and a certificate. Everything else in
this page is either why, or the exception.

## The constraint that decides it

**A diner uses their own mobile data.** They tap an NFC tag and expect a page,
and they are not going to join the restaurant's WiFi first — on iOS that means
fighting a captive portal before dinner.

That single fact rules out every local arrangement for the *table screen*. A page
served from `192.168.1.50` is unreachable from a phone on a cellular network, and
a tunnel from a machine behind the bar is a workaround for a problem that
disappears if the backend simply lives somewhere with an address.

So: one hosted backend. The gadget dials `wss://` outbound from the restaurant
WiFi, the diner's phone opens `https://`, and there is nothing in the restaurant
to install, forward, or keep switched on.

## Why it cannot be a Supabase function

Four things the backend does, and none of them fit a short stateless request:

1. **Meters speech in real time.** The model emits a whole sentence at once. Sent
   onward as it arrives it overruns the device buffer and the reply comes out
   chopped, so frames go out on a 20 ms tick for the length of the meal, with
   16 ↔ 24 kHz resampling both ways.
2. **Knows when a turn ended** — when the speaker finishes, not when the model
   stops generating. Get that wrong and the agent hears itself, answers itself,
   and orders its own dinner. We shipped that bug once.
3. **Separates customers by bearing**, sampling angles only while somebody is
   actually speaking and averaging them circularly.
4. **Holds the order** and fans it out to every screen watching that table.

The Supabase function in this project does exactly one thing — relay audio to the
model — and knows nothing about tables.

## Deploying it

```bash
cp deploy/cloud/.env.example deploy/cloud/.env    # fill in the venue key
# point your domain at the host, then:
docker compose -f deploy/cloud/docker-compose.yml up -d
```

Caddy obtains and renews the certificate on its own; there is nothing else to
configure. The gadget's WebSocket and the diner's page go through the same proxy.

The gadget ships pointing at the hosted backend on port 443 and speaks TLS. The
setup portal still shows a server field, but behind a heading that says it is
only for somebody running their own — most people never touch it.

## The exceptions

**A restaurant with no reliable internet.** Then the whole thing has to be local,
including the model, and that is the offline mode — still unbuilt, and blocked on
the reComputer's power supply. Note that in this case the diner's phone must be
on the restaurant's WiFi; there is no way around it, because there is no public
address to reach.

**Somebody who wants to run their own backend** — a chain with its own
infrastructure, or a replicator who does not want to depend on us. Two supported
shapes:

- `deploy/recomputer/install.sh` — installs it as a systemd service on a
  reComputer R1025. Data lives in `/var/lib/mesero-ai` so an update never
  overwrites a carta somebody changed mid-service.
- `desktop/build.mjs` — builds the backend into a single executable for a
  Windows PC. It has no interface: it is a service, and it prints its addresses
  and then serves. If it ever becomes something a restaurant installs by itself
  it needs a real front end, and right now it is not on that path.

Both of these serve a LAN address, which means the diner's phone has to be on the
restaurant's WiFi. That is the trade, and it is the reason the hosted deployment
is the default rather than one option among three.

## Do not forward a port

If you run this locally anyway, do not open a port to it. The table screen has no
authentication — deliberately, because a diner cannot be asked to log in — and
that is only safe while reaching it requires being on the premises. Use an
outbound tunnel (`cloudflared tunnel --url http://localhost:8787`) if you need it
reachable, so there is no inbound hole in the firewall.
