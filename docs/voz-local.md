# Running the voice model yourself

Three ways to give this project a voice. Pick one with `PROVIDER`.

| | What you configure | Where the secret lives |
| --- | --- | --- |
| `gabotrix` *(default)* | A venue key | Nowhere near you |
| `openai` | Your own `OPENAI_API_KEY` | On your machine |
| `local` | A URL on your network | There is no secret |

The device, the session and the table screen cannot tell which one is running.
Adding a fourth is one file in `backend/src/providers/` and a branch in the
factory.

Note that `openai` and `local` both mean **you host the backend**. That is not a
restriction we invented — we cannot reach a model on your LAN, and we should not
be holding your vendor key.

## Why you might want `local`

Not privacy, though you get it. Not cost, though it is lower. The reason is that
a restaurant with bad internet still has to serve dinner, and every other option
here dies with the connection.

A reComputer R1025 or any small Linux box will do. What runs on it is your
choice — whisper.cpp for speech, a small instruct model, Piper for the voice —
because this project does not care, as long as the thing in front of them speaks
the envelope below.

## The contract

One WebSocket. JSON both ways. Audio is PCM16LE mono at 24 kHz, base64-encoded.
It is the same shape the hosted bridge speaks, on purpose: an adapter is about a
hundred lines, not a rewrite.

```
PROVIDER=local
LOCAL_VOICE_URL=ws://recomputer.local:8080/voice
# LOCAL_VOICE_TOKEN=            optional; a box on your own LAN has nobody to prove itself to
```

### Backend → you

| Message | When |
| --- | --- |
| `{"type":"session.update","session":{"instructions":"…","tools":[…]}}` | First thing on connect. The persona and the tools the agent may call. Ignore it and the agent still talks — it just will not know the carta. |
| `{"realtimeInput":{"audio":{"data":"<b64>","mimeType":"audio/pcm;rate=24000"}}}` | Microphone audio, continuously. |
| `{"textMessage":"…"}` | A user turn injected as text, from a button on the table screen. |
| `{"type":"response.cancel"}` | Somebody talked over the agent. Stop generating now. |

### You → backend

| Message | Meaning |
| --- | --- |
| `{"setupComplete":true}` | Ready. Nothing is sent until this arrives. |
| `{"serverContent":{"modelTurn":{"parts":[{"inlineData":{"data":"<b64>"}}]}}}` | Speech, as it is produced. Send it in pieces; do not wait for the sentence. |
| `{"serverContent":{"turnComplete":true}}` | You finished generating. |
| `{"serverContent":{"interrupted":true}}` | You noticed the diner talking over you first. |
| `{"toolCall":{"functionCalls":[{"id":"…","name":"add_item","args":{…}}]}}` | The agent wants to change the order. |
| `{"error":"…"}` | Anything that went wrong. |

## Two things that will bite you

**`turnComplete` is not the end of the turn.** It means you stopped generating.
The backend meters audio to the gadget at real time, so playback trails
generation by the length of the queue. Treating it as the end opens the
microphone while the speaker is still talking, and the agent hears itself,
answers itself, and orders its own dinner. We shipped that bug. The backend
handles this — you just need to know that `turnComplete` is about you, not about
the table.

**Send audio in pieces.** A whole sentence delivered at once overruns the
device's buffer and comes out chopped. The backend meters what you send, but it
cannot smooth what it never received.

## Latency, honestly

The hosted path answers in well under a second. A small model on a Pi-class box
will not, and the gap is most of a second of somebody sitting at a table waiting.
It is a real trade, not a footnote: a slower agent that always works may still be
the right answer for a restaurant whose internet drops at seven in the evening,
but decide it knowing that is the choice.
