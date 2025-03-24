const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
require('dotenv').config();

// Initialize Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const db = admin.firestore();

// Serve static files from the public directory
app.use(express.static('public'));
app.use(express.json());

// Authentication middleware
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid token' });
    }
};

// Meeting routes
app.post('/api/meetings', authenticateToken, async (req, res) => {
    const meetingId = uuidv4();
    const meetingData = {
        id: meetingId,
        host: req.user.uid,
        participants: {},
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        settings: {
            muteOnJoin: false,
            hostControls: true,
            allowChat: true
        }
    };

    try {
        await db.collection('meetings').doc(meetingId).set(meetingData);
        res.json({ meetingId });
    } catch (error) {
        console.error('Error creating meeting:', error);
        res.status(500).json({ error: 'Failed to create meeting' });
    }
});

app.get('/api/meetings/:meetingId', authenticateToken, async (req, res) => {
    try {
        const meetingDoc = await db.collection('meetings').doc(req.params.meetingId).get();
        if (!meetingDoc.exists) {
            return res.status(404).json({ error: 'Meeting not found' });
        }
        res.json(meetingDoc.data());
    } catch (error) {
        console.error('Error fetching meeting:', error);
        res.status(500).json({ error: 'Failed to fetch meeting' });
    }
});

// WebRTC Signaling and Meeting Management
const activeSessions = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-meeting', async ({ meetingId, userId, displayName }) => {
        try {
            const meetingRef = db.collection('meetings').doc(meetingId);
            const meetingDoc = await meetingRef.get();

            if (!meetingDoc.exists) {
                socket.emit('error', { message: 'Meeting not found' });
                return;
            }

            const meeting = meetingDoc.data();
            socket.join(meetingId);
            const isHost = meeting.host === userId;

            const participantData = {
                id: userId,
                displayName,
                isHost,
                audioEnabled: true,
                videoEnabled: true,
                socketId: socket.id,
                joinedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            await meetingRef.update({
                [`participants.${userId}`]: participantData
            });

            activeSessions.set(socket.id, { meetingId, userId });

            // Notify others about the new participant
            io.to(meetingId).emit('participant-joined', {
                userId,
                displayName,
                isHost,
                participants: Object.values(meeting.participants || {})
            });
        } catch (error) {
            console.error('Error joining meeting:', error);
            socket.emit('error', { message: 'Failed to join meeting' });
        }
    });

    socket.on('offer', ({ meetingId, offer, userId, targetUserId }) => {
        const targetSocket = activeSessions.get(targetUserId)?.socketId;
        if (targetSocket) {
            io.to(targetSocket).emit('offer', { offer, userId });
        }
    });

    socket.on('answer', ({ meetingId, answer, userId, targetUserId }) => {
        const targetSocket = activeSessions.get(targetUserId)?.socketId;
        if (targetSocket) {
            io.to(targetSocket).emit('answer', { answer, userId });
        }
    });

    socket.on('ice-candidate', ({ meetingId, candidate, userId, targetUserId }) => {
        const targetSocket = activeSessions.get(targetUserId)?.socketId;
        if (targetSocket) {
            io.to(targetSocket).emit('ice-candidate', { candidate, userId });
        }
    });

    // Host Controls
    socket.on('mute-participant', async ({ meetingId, userId, targetUserId }) => {
        try {
            const meetingRef = db.collection('meetings').doc(meetingId);
            const meetingDoc = await meetingRef.get();
            const meeting = meetingDoc.data();

            if (meeting && meeting.host === userId) {
                const targetSocket = activeSessions.get(targetUserId)?.socketId;
                if (targetSocket) {
                    io.to(targetSocket).emit('mute-audio');
                    io.to(meetingId).emit('participant-muted', { userId: targetUserId });
                }
            }
        } catch (error) {
            console.error('Error muting participant:', error);
        }
    });

    socket.on('remove-participant', async ({ meetingId, userId, targetUserId }) => {
        try {
            const meetingRef = db.collection('meetings').doc(meetingId);
            const meetingDoc = await meetingRef.get();
            const meeting = meetingDoc.data();

            if (meeting && meeting.host === userId) {
                const targetSocket = activeSessions.get(targetUserId)?.socketId;
                if (targetSocket) {
                    io.to(targetSocket).emit('kicked-from-meeting');
                    await meetingRef.update({
                        [`participants.${targetUserId}`]: admin.firestore.FieldValue.delete()
                    });
                    io.to(meetingId).emit('participant-removed', { userId: targetUserId });
                }
            }
        } catch (error) {
            console.error('Error removing participant:', error);
        }
    });

    socket.on('end-meeting', async ({ meetingId, userId }) => {
        try {
            const meetingRef = db.collection('meetings').doc(meetingId);
            const meetingDoc = await meetingRef.get();
            const meeting = meetingDoc.data();

            if (meeting && meeting.host === userId) {
                io.to(meetingId).emit('meeting-ended');
                await meetingRef.delete();
            }
        } catch (error) {
            console.error('Error ending meeting:', error);
        }
    });

    socket.on('chat-message', async ({ meetingId, message, userId }) => {
        try {
            const meetingRef = db.collection('meetings').doc(meetingId);
            const chatRef = meetingRef.collection('chat');
            
            const messageData = {
                message,
                userId,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            };

            await chatRef.add(messageData);
            const meeting = (await meetingRef.get()).data();

            if (meeting && meeting.settings.allowChat) {
                const participant = meeting.participants[userId];
                if (participant) {
                    io.to(meetingId).emit('chat-message', {
                        ...messageData,
                        displayName: participant.displayName
                    });
                }
            }
        } catch (error) {
            console.error('Error sending chat message:', error);
        }
    });

    socket.on('leave-meeting', ({ meetingId, userId }) => {
        handleParticipantLeave(socket, meetingId, userId);
    });

    socket.on('disconnect', () => {
        const session = activeSessions.get(socket.id);
        if (session) {
            handleParticipantLeave(socket, session.meetingId, session.userId);
            activeSessions.delete(socket.id);
        }
        console.log('User disconnected:', socket.id);
    });
});

async function handleParticipantLeave(socket, meetingId, userId) {
    try {
        const meetingRef = db.collection('meetings').doc(meetingId);
        const meetingDoc = await meetingRef.get();
        
        if (meetingDoc.exists) {
            const meeting = meetingDoc.data();
            socket.leave(meetingId);

            await meetingRef.update({
                [`participants.${userId}`]: admin.firestore.FieldValue.delete()
            });

            io.to(meetingId).emit('participant-left', { userId });

            // If host leaves, end the meeting
            if (meeting.host === userId) {
                io.to(meetingId).emit('meeting-ended');
                await meetingRef.delete();
            }
        }
    } catch (error) {
        console.error('Error handling participant leave:', error);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 