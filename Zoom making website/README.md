# Zoom Clone

A real-time video conferencing application built with HTML, CSS, JavaScript, and WebRTC.

## Features

- User authentication (register/login)
- Create and join meetings
- Real-time video and audio communication
- Screen sharing
- Text chat
- Responsive design
- Modern UI/UX

## Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)
- Modern web browser with WebRTC support

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd zoom-clone
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory and add your JWT secret:
```
JWT_SECRET=your-secret-key
```

4. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

5. Open your browser and navigate to:
```
http://localhost:3000
```

## Usage

1. Register a new account or login with existing credentials
2. Create a new meeting or join an existing one using the meeting code
3. Allow camera and microphone access when prompted
4. Use the control buttons to:
   - Toggle microphone
   - Toggle camera
   - Share screen
   - Open/close chat
   - Leave meeting

## Technical Stack

- Frontend:
  - HTML5
  - CSS3
  - JavaScript (ES6+)
  - WebRTC API
  - Socket.IO Client

- Backend:
  - Node.js
  - Express.js
  - Socket.IO
  - JWT for authentication
  - WebRTC Signaling Server

## Security Considerations

- JWT-based authentication
- Password hashing with bcrypt
- Secure WebRTC connections
- HTTPS recommended for production

## Browser Support

- Chrome (recommended)
- Firefox
- Safari
- Edge

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details. 