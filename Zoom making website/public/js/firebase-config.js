// Import Firebase modules
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.x.x/firebase-app.js';
import { getAuth, signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/9.x.x/firebase-auth.js';
import { getFirestore, collection, doc, setDoc, getDoc, updateDoc, deleteDoc } from 'https://www.gstatic.com/firebasejs/9.x.x/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/9.x.x/firebase-storage.js';
import { getDatabase, ref as dbRef, set, onValue, push } from 'https://www.gstatic.com/firebasejs/9.x.x/firebase-database.js';

// Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
    apiKey: "AIzaSyA31cRyEmbW3UuiF6vNjB9Jt9Sf-hkPrzk",
    authDomain: "meeting-72433.firebaseapp.com",
    databaseURL: "https://meeting-72433-default-rtdb.firebaseio.com",
    projectId: "meeting-72433",
    storageBucket: "meeting-72433.firebasestorage.app",
    messagingSenderId: "30125020621",
    appId: "1:30125020621:web:ad2a35ff43b5e6e4be2084",
    measurementId: "G-5ZM145V700"
  };

// Initialize Firebase services
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const rtdb = getDatabase(app);
const googleProvider = new GoogleAuthProvider();

// Authentication functions
export const signInWithGoogle = async () => {
    try {
        const result = await signInWithPopup(auth, googleProvider);
        return result.user;
    } catch (error) {
        console.error('Google sign-in error:', error);
        throw error;
    }
};

export const signInWithEmail = async (email, password) => {
    try {
        const result = await signInWithEmailAndPassword(auth, email, password);
        return result.user;
    } catch (error) {
        console.error('Email sign-in error:', error);
        throw error;
    }
};

export const registerWithEmail = async (email, password, displayName) => {
    try {
        const result = await createUserWithEmailAndPassword(auth, email, password);
        await result.user.updateProfile({ displayName });
        return result.user;
    } catch (error) {
        console.error('Registration error:', error);
        throw error;
    }
};

// Meeting management functions
export const createMeeting = async (userId, settings = {}) => {
    const meetingRef = doc(collection(db, 'meetings'));
    const meetingId = meetingRef.id;
    
    const meetingData = {
        id: meetingId,
        host: userId,
        createdAt: new Date().toISOString(),
        settings: {
            waitingRoom: true,
            requirePassword: settings.password ? true : false,
            password: settings.password || null,
            muteOnEntry: true,
            allowChat: true,
            allowScreenShare: true,
            allowRecording: true,
            maxParticipants: 100,
            ...settings
        },
        participants: {},
        coHosts: [],
        waitingRoom: {},
        status: 'active'
    };

    await setDoc(meetingRef, meetingData);
    return meetingId;
};

export const joinMeeting = async (meetingId, userId, displayName, password = null) => {
    const meetingRef = doc(db, 'meetings', meetingId);
    const meetingDoc = await getDoc(meetingRef);

    if (!meetingDoc.exists()) {
        throw new Error('Meeting not found');
    }

    const meeting = meetingDoc.data();

    if (meeting.settings.requirePassword && meeting.settings.password !== password) {
        throw new Error('Invalid meeting password');
    }

    const participantData = {
        id: userId,
        displayName,
        joinedAt: new Date().toISOString(),
        role: meeting.host === userId ? 'host' : 'participant',
        audioEnabled: false,
        videoEnabled: false,
        isHandRaised: false
    };

    if (meeting.settings.waitingRoom && meeting.host !== userId) {
        await updateDoc(meetingRef, {
            [`waitingRoom.${userId}`]: participantData
        });
        return 'waiting';
    }

    await updateDoc(meetingRef, {
        [`participants.${userId}`]: participantData
    });
    return 'joined';
};

// Chat and reactions
export const sendChatMessage = async (meetingId, userId, message, type = 'text') => {
    const chatRef = dbRef(rtdb, `chats/${meetingId}`);
    const newMessageRef = push(chatRef);
    
    await set(newMessageRef, {
        userId,
        message,
        type,
        timestamp: new Date().toISOString()
    });
};

export const sendReaction = async (meetingId, userId, reaction) => {
    const reactionRef = dbRef(rtdb, `reactions/${meetingId}`);
    const newReactionRef = push(reactionRef);
    
    await set(newReactionRef, {
        userId,
        reaction,
        timestamp: new Date().toISOString()
    });
};

// File handling
export const uploadFile = async (meetingId, file) => {
    const fileRef = ref(storage, `meetings/${meetingId}/files/${file.name}`);
    await uploadBytes(fileRef, file);
    const downloadURL = await getDownloadURL(fileRef);
    return downloadURL;
};

// Recording management
export const startRecording = async (meetingId, stream) => {
    const chunks = [];
    const mediaRecorder = new MediaRecorder(stream);
    
    mediaRecorder.ondataavailable = async (e) => {
        chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const recordingRef = ref(storage, `recordings/${meetingId}/${new Date().getTime()}.webm`);
        await uploadBytes(recordingRef, blob);
        const downloadURL = await getDownloadURL(recordingRef);
        
        await updateDoc(doc(db, 'meetings', meetingId), {
            recordings: arrayUnion({
                url: downloadURL,
                timestamp: new Date().toISOString()
            })
        });
    };

    mediaRecorder.start();
    return mediaRecorder;
};

export { auth, db, storage, rtdb }; 