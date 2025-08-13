# WhatsApp WebRTC Bridge

A real-time WhatsApp voice calling integration using the WhatsApp Business API and WebRTC. This application enables two-way audio communication between browser clients and WhatsApp users.

## Features

- ✅ **Incoming Calls**: Receive and handle incoming WhatsApp calls
- ✅ **Outgoing Calls**: Initiate calls to WhatsApp users
- ✅ **WebRTC Bridge**: Real-time audio streaming between browser and WhatsApp
- ✅ **Webhook Verification**: Proper webhook setup for WhatsApp Business API
- ✅ **Call Management**: Accept, reject, and terminate calls
- ✅ **Call Timer**: Track call duration
- ✅ **Modern UI**: Clean, responsive web interface

## Prerequisites

- Node.js (v14 or higher)
- WhatsApp Business API access
- Public HTTPS endpoint (for webhook)
- Build tools for native modules

## Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd whatsapp-calling
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Install build tools (Linux)**
   ```bash
   sudo apt update
   sudo apt install -y build-essential python3 make gcc g++ libtool autoconf automake
   npm install -g node-pre-gyp
   ```

4. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` with your WhatsApp Business API credentials:
   ```env
   PORT=19000
   PHONE_NUMBER_ID=your_phone_number_id
   ACCESS_TOKEN=your_access_token
   VERIFY_TOKEN=your_custom_verify_token
   ```

## WhatsApp Business API Setup

### 1. Configure Webhook URL

In your WhatsApp Business API dashboard, set the webhook URL to:
```
https://your-domain.com/webhook
```

### 2. Configure Webhook Fields

Subscribe to these webhook fields:
- `messages`
- `message_deliveries`
- `message_reads`
- `calls`

### 3. Set Verify Token

Use the same verify token as in your `.env` file (default: `sandeep_bora`).

## Usage

### Starting the Server

```bash
node server.js
```

The server will start on `http://localhost:19000`

### Web Interface

Open `http://localhost:19000` in your browser to access the web interface.

#### Incoming Calls
- When a WhatsApp call comes in, a modal will appear
- Click the green button to accept or red button to reject
- Once accepted, WebRTC connection is established for two-way audio

#### Outgoing Calls
- Enter a phone number in the "Make Outgoing Call" section
- Optionally add a caller name
- Click "Call" to initiate an outgoing call
- Wait for the recipient to answer

### API Endpoints

#### Webhook Verification (GET)
```
GET /webhook?hub.mode=subscribe&hub.verify_token=your_token&hub.challenge=challenge_string
```

#### Webhook Events (POST)
```
POST /webhook
```
Handles incoming call events from WhatsApp.

#### Initiate Outgoing Call (POST)
```bash
curl -X POST http://localhost:19000/initiate-call \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "1234567890",
    "callerName": "John Doe"
  }'
```

## Webhook Events

The application handles these WhatsApp call events:

- `connect`: Incoming call received
- `answer`: Outgoing call answered
- `reject`: Outgoing call rejected
- `terminate`: Call ended
- `timeout`: Outgoing call timed out

## Testing

### Test Webhook Verification
```bash
node test-outgoing-call.js
```

### Manual Testing
1. Start the server: `node server.js`
2. Open `http://localhost:19000`
3. Test incoming calls by triggering a call to your WhatsApp number
4. Test outgoing calls using the web interface

## Troubleshooting

### Common Issues

1. **wrtc installation fails**
   ```bash
   npm cache clean --force
   npm install wrtc --build-from-source
   ```

2. **Webhook verification fails**
   - Ensure your verify token matches in both WhatsApp dashboard and `.env`
   - Check that your webhook URL is publicly accessible
   - Verify HTTPS is enabled

3. **Calls not connecting**
   - Check your WhatsApp Business API credentials
   - Ensure your phone number is properly configured
   - Verify webhook events are being received

### Debug Mode

Enable detailed logging by setting:
```bash
DEBUG=* node server.js
```

## Architecture

```
Browser Client ←→ WebRTC ←→ Server ←→ WhatsApp Business API
```

- **Browser**: Handles user interface and WebRTC peer connection
- **Server**: Manages WebRTC bridge and WhatsApp API communication
- **WhatsApp API**: Handles actual voice calls and routing

## Security Considerations

- Use HTTPS in production
- Validate all incoming webhook data
- Implement rate limiting
- Secure your access tokens
- Use environment variables for sensitive data

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review WhatsApp Business API documentation
3. Open an issue on GitHub

---

**Note**: This application requires a valid WhatsApp Business API account and proper webhook configuration to function correctly.
