// Twilio Function sample — paste this into a Twilio Function (or serve it from
// your own infra) and set it as the voice REQUEST URL of your TwiML App.
//
// What it does: when the browser places a call via Twilio Voice SDK, Twilio
// hits this webhook and dials the requested number through YOUR caller ID.
//
// Twilio Functions version (console.twilio.com -> Functions & Assets -> Create):
//
exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();

  // The extension passes the destination as a "To" connection parameter.
  const to = event.To || event.request?.parameters?.To;
  // CallerId: allow the extension to override, else fall back to your number
  const callerId = event.CallerId || event.request?.parameters?.CallerId || context.TWILIO_CALLER_ID;

  if (!to || !/^\+[1-9]\d{6,14}$/.test(to)) {
    twiml.say("Invalid destination number.");
    return callback(null, twiml);
  }

  const dial = twiml.dial({ callerId, answerOnBridge: true });
  dial.number(to);

  callback(null, twiml);
};
