const express = require('express');
const cors = require('cors');
const { sendMessage, getStatus } = require('./whatsapp'); 

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());


app.post('/api/whatsapp/send', async (req, res) => {
    // Destructure pdfUrl just in case you use it later
    const { centerId, phone, message, pdfUrl } = req.body;

    if (!centerId || !phone || !message) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const success = await sendMessage(centerId, phone, message, pdfUrl);
        if (success) {
            res.status(200).json({ success: true, message: 'WhatsApp message sent silently!' });
        } else {
            res.status(400).json({ error: 'Number not registered on WhatsApp' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.post('/api/sms/send', async (req, res) => {
    const { centerId, phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Missing phone or message payload' });
    }

    try {
        let formattedPhone = phone.trim();
        // Standardize Egyptian phone numbers just like WhatsApp logic
        if (formattedPhone.startsWith('01')) formattedPhone = `2${formattedPhone}`;
        else if (!formattedPhone.startsWith('20')) formattedPhone = `20${formattedPhone}`;

        console.log(`[SMS Gateway] Initiating SMS text to: ${formattedPhone}`);
        console.log(`[SMS Message]: ${message}`);

        // -------------------------------------------------------------
        // 🚨 PLUG YOUR SMS PROVIDER API HERE
        // (e.g., Twilio, Vodafone, Orange, or a local SMS Gateway provider)
        // -------------------------------------------------------------
        // Example: 
        // await smsProvider.send({ to: formattedPhone, body: message });

        res.status(200).json({ success: true, message: 'SMS notification processed successfully!' });
    } catch (error) {
        console.error("❌ SMS Dispatch Failed:", error.message);
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/whatsapp/status', (req, res) => {
    const centerId = req.query.centerId || 'lab';
    
    // getStatus is already imported from whatsapp.js at the top of your file
    const status = getStatus(centerId); 
    
    res.json(status);
});

const PORT = process.env.NODE_PORT || 5050;
// Express 5 hands listen errors to this callback instead of throwing. Without this check a second
// copy of the service would print "running" while another copy keeps answering on the port --
// it would show a QR code in its own terminal that the app (talking to the other copy) never sees.
app.listen(PORT, (err) => {
    if (err) {
        console.error(err.code === 'EADDRINUSE'
            ? `❌ Port ${PORT} is already in use -- another copy of this service is running. Stop it first ` +
              `(sudo systemctl stop ticket-engine-whatsapp, or: sudo fuser -k ${PORT}/tcp), then start this one again.`
            : `❌ Could not listen on port ${PORT}: ${err.message}`);
        process.exit(1);
    }
    console.log(`Node Server: WhatsApp Microservice running on port ${PORT}`);
    getStatus('lab');  // start the WhatsApp client only once the port is ours
});
