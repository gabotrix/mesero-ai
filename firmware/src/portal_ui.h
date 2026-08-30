#pragma once
#include <Arduino.h>

/**
 * The setup portal's skin.
 *
 * The first thing anybody sees of this project is not the table screen — it is
 * this page, on a phone, standing next to a device that does not work yet.
 * WiFiManager's default reads like a router admin page and gives no signal that
 * the thing in your hand is finished.
 *
 * The branding is pure CSS on purpose. An earlier version built the header with
 * a script, which meant that anywhere the script did not run — a saved copy, a
 * restricted captive-portal browser, a snapshot — the page lost its logo and
 * looked broken. A background-image on body::before always renders.
 *
 * The logo is the real mark, downscaled to 400 px and stripped to white plus
 * alpha, which is all the information a flat silhouette carries. 11 KB of
 * base64, served from the device itself: the portal runs on an access point with
 * no internet behind it, so nothing here can be fetched.
 *
 * On the QR: the venue key can arrive as ?venue= in the URL, which is what the
 * console encodes. It cannot be scanned *by this page* — getUserMedia needs a
 * secure context and a captive portal is plain HTTP at 192.168.4.1, so no
 * browser will open a camera here. The phone's own camera app scans it, opens
 * this URL, and the field fills itself.
 */

static const char PORTAL_HEAD[] PROGMEM = R"HEAD(
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b4ea2">
<style>
:root{
  --brand:#1a73e8; --deep:#072f63; --mid:#0b4ea2;
  --ink:#0e1c2b; --muted:#61707f; --line:#e2e8f0; --field:#f7f9fc;
}
*{box-sizing:border-box}
body{
  margin:0; padding:0 0 44px; min-height:100vh;
  background:#eef2f7; color:var(--ink);
  font-family:'Montserrat',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  -webkit-font-smoothing:antialiased; font-size:15px;
}

/* Header, logo and all, without a line of script. */
body:before{
  content:"Configura esta mesa";
  display:block; padding:84px 20px 26px;
  background:
    url("data:image/png;base64,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") no-repeat center 30px / 188px auto,
    radial-gradient(ellipse 70% 130% at 15% 0%,rgba(77,151,245,.55),transparent 65%),
    linear-gradient(150deg,var(--deep),var(--mid) 55%,var(--brand));
  color:#cfe0f7; text-align:center;
  font-size:12.5px; font-weight:600; letter-spacing:.09em; text-transform:uppercase;
}

.wrap{
  width:min(100%,440px); margin:-16px auto 0; position:relative;
  padding:22px 20px 24px; background:#fff;
  border:1px solid var(--line); border-radius:18px;
  box-shadow:0 14px 34px rgba(7,47,99,.13); text-align:left;
}
@media(max-width:480px){ .wrap{margin:-16px 12px 0} }

h1{margin:0 0 18px; font-size:21px; font-weight:800; letter-spacing:-.02em}
h3{margin:0 0 12px; font-size:14px; font-weight:800; color:var(--muted)}

label,dt{display:block; margin-bottom:5px; font-size:12px; font-weight:800; letter-spacing:.02em}
input,select{
  width:100%; padding:13px 14px; margin:0 0 15px;
  font:inherit; font-size:16px;      /* under 16px and iOS zooms on focus */
  font-weight:600; color:var(--ink); background:var(--field);
  border:1px solid var(--line); border-radius:11px;
}
input:focus,select:focus{
  outline:none; background:#fff; border-color:var(--brand);
  box-shadow:0 0 0 3px rgba(26,115,232,.18);
}
input::placeholder{font-weight:500; color:#9aa8b6}

button,input[type=submit]{
  width:100%; min-height:52px; margin:6px 0 4px; padding:0 18px;
  font:inherit; font-size:15px; font-weight:800; letter-spacing:.01em;
  color:#fff; cursor:pointer; border:0; border-radius:13px;
  background:linear-gradient(135deg,var(--mid),var(--brand));
  box-shadow:0 8px 20px rgba(26,115,232,.30);
}
button:active{transform:translateY(1px)}
a{color:var(--brand); font-weight:700; text-decoration:none}

.msg{
  padding:13px 15px; margin:0 0 18px; font-size:13px; line-height:1.55;
  color:#0b3c78; background:#eaf2fd; border:1px solid #cfe0f7;
  border-radius:12px;
}
.q{float:right; color:var(--muted); font-size:11.5px; font-weight:700}

/* Folded away, not removed: most people never open it, and somebody running
   their own backend must still be able to find it. */
.gbx-adv{margin:4px 0 16px; border-top:1px solid var(--line); padding-top:12px}
.gbx-adv summary{
  cursor:pointer; list-style:none;
  font-size:12.5px; font-weight:800; color:var(--muted);
}
.gbx-adv summary::-webkit-details-marker{display:none}
.gbx-adv summary:before{content:"+ "; font-weight:800}
.gbx-adv[open] summary:before{content:"- "}
.gbx-adv-note{margin:10px 0 14px; font-size:11.5px; line-height:1.55; color:var(--muted)}
.gbx-hint{margin:-10px 0 16px; font-size:11.5px; line-height:1.5; color:var(--muted)}
.gbx-ok{color:#0f7b46; font-weight:700}
</style>
<script>
// Everything the gadget needs can ride in on the URL — that is what the QR the
// console prints for each table encodes. Held in sessionStorage because
// WiFiManager walks across more than one page and the query string does not
// survive the trip.
//
// It is one QR per table, not one per restaurant: the dock is what pairs this
// gadget with the diner's phone, and it differs at every table.
document.addEventListener('DOMContentLoaded',function(){
  var FIELDS=['venue','dock','host','port'];
  try{
    var q=new URLSearchParams(location.search), got=false;
    FIELDS.forEach(function(k){
      var v=q.get(k);
      if(v){ sessionStorage.setItem('gbx_'+k,v); }
    });
    FIELDS.forEach(function(k){
      var v=sessionStorage.getItem('gbx_'+k);
      var f=document.getElementById(k);
      // The QR wins over what is on the device. It has to: the table id always
      // starts at its compiled default, so refusing to overwrite left every
      // table after the first one silently calling itself mesa-01. The person
      // sees what it filled in and confirms before saving — that is the check.
      if(f&&v){ f.value=v; got=true; }
    });
    var anchor=document.getElementById('venue');
    if(got&&anchor){
      var h=document.createElement('p');
      h.className='gbx-hint';
      h.innerHTML='<span class="gbx-ok">Datos recibidos del codigo QR.</span> '
        +'Revisalos y elige tu red WiFi; se guardan al terminar.';
      anchor.parentNode.insertBefore(h,anchor.nextSibling);
    }
  }catch(e){}
});
</script>
)HEAD";
