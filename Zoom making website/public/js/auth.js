// Import Firebase functions
import { 
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signInAnonymously,
    signInWithPopup,
    signOut,
    onAuthStateChanged,
    GoogleAuthProvider
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    doc, 
    setDoc,
    getDoc,
    collection 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Get Firebase instances
const { auth, db, googleProvider } = window.firebaseApp;

// UI Elements
const authContainer = document.querySelector('.auth-container');
const dashboardContainer = document.querySelector('.dashboard-container');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const guestForm = document.getElementById('guest-form');
const tabButtons = document.querySelectorAll('.tab-btn');
const logoutBtn = document.getElementById('logout-btn');

// Show/Hide Message
function showMessage(message, isError = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `auth-message ${isError ? 'error' : 'success'}`;
    messageDiv.textContent = message;
    
    const container = document.querySelector('.auth-box');
    container.appendChild(messageDiv);
    
    setTimeout(() => {
        messageDiv.remove();
    }, 5000);
}

// Tab Switching
tabButtons.forEach(button => {
    button.addEventListener('click', () => {
        tabButtons.forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');
        
        const forms = {
            'login': loginForm,
            'signup': signupForm,
            'guest': guestForm
        };
        
        Object.values(forms).forEach(form => form.classList.add('hidden'));
        forms[button.dataset.tab].classList.remove('hidden');
    });
});

// Login Form Submit
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = e.target.querySelector('input[type="email"]').value;
    const password = e.target.querySelector('input[type="password"]').value;

    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        
        // Get user data from Firestore
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (userDoc.exists()) {
            showMessage('Login successful!');
        } else {
            // Create user document if it doesn't exist
            await setDoc(doc(db, 'users', user.uid), {
                email: user.email,
                createdAt: new Date().toISOString(),
                settings: {
                    defaultMicMuted: true,
                    defaultVideoOff: false,
                    enablePushNotifications: true
                }
            });
        }
    } catch (error) {
        console.error('Login error:', error);
        showMessage(error.message, true);
    }
});

// Sign Up Form Submit
signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fullName = e.target.querySelector('input[type="text"]').value;
    const email = e.target.querySelector('input[type="email"]').value;
    const password = e.target.querySelectorAll('input[type="password"]')[0].value;
    const confirmPassword = e.target.querySelectorAll('input[type="password"]')[1].value;

    if (password !== confirmPassword) {
        showMessage('Passwords do not match!', true);
        return;
    }

    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        // Create user profile in Firestore
        await setDoc(doc(db, 'users', user.uid), {
            fullName,
            email,
            createdAt: new Date().toISOString(),
            settings: {
                defaultMicMuted: true,
                defaultVideoOff: false,
                enablePushNotifications: true
            }
        });

        showMessage('Account created successfully!');
        
        // Update display name
        await updateProfile(user, {
            displayName: fullName
        });
    } catch (error) {
        console.error('Signup error:', error);
        showMessage(error.message, true);
    }
});

// Guest Form Submit
guestForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.querySelector('input[type="text"]').value;
    const meetingId = e.target.querySelectorAll('input[type="text"]')[1].value;
    const password = e.target.querySelector('input[type="password"]').value;

    try {
        // Check if meeting exists and validate password if required
        const meetingRef = doc(db, 'meetings', meetingId);
        const meetingDoc = await getDoc(meetingRef);

        if (!meetingDoc.exists()) {
            showMessage('Meeting not found!', true);
            return;
        }

        const meetingData = meetingDoc.data();
        if (meetingData.password && meetingData.password !== password) {
            showMessage('Invalid meeting password!', true);
            return;
        }

        // Create temporary guest user
        const guestUser = await signInAnonymously(auth);
        await setDoc(doc(db, 'users', guestUser.user.uid), {
            fullName: name,
            isGuest: true,
            createdAt: new Date().toISOString()
        });

        // Redirect to meeting
        window.location.href = `/meeting.html?id=${meetingId}`;
    } catch (error) {
        console.error('Guest join error:', error);
        showMessage(error.message, true);
    }
});

// Google Sign In
document.querySelectorAll('.social-btn.google').forEach(button => {
    button.addEventListener('click', async () => {
        try {
            const result = await signInWithPopup(auth, googleProvider);
            const user = result.user;
            
            // Create or update user profile in Firestore
            await setDoc(doc(db, 'users', user.uid), {
                fullName: user.displayName,
                email: user.email,
                photoURL: user.photoURL,
                createdAt: new Date().toISOString(),
                settings: {
                    defaultMicMuted: true,
                    defaultVideoOff: false,
                    enablePushNotifications: true
                }
            }, { merge: true });

            showMessage('Login successful!');
        } catch (error) {
            console.error('Google sign-in error:', error);
            showMessage(error.message, true);
        }
    });
});

// Logout
logoutBtn?.addEventListener('click', async () => {
    try {
        await signOut(auth);
        window.location.href = '/';
    } catch (error) {
        console.error('Logout error:', error);
        showMessage('Error signing out!', true);
    }
});

// Auth State Change Handler
onAuthStateChanged(auth, async (user) => {
    if (user) {
        // Update UI for authenticated user
        authContainer.classList.add('hidden');
        dashboardContainer.classList.remove('hidden');
        
        // Update user info in dashboard
        const userNameSpan = document.getElementById('user-name');
        const userEmailSpan = document.getElementById('user-email');
        
        // Get user data from Firestore
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        const userData = userDoc.data();
        
        if (userNameSpan) {
            userNameSpan.textContent = userData?.fullName || user.displayName || 'User';
        }
        if (userEmailSpan) {
            userEmailSpan.textContent = user.email || '';
        }
    } else {
        // Update UI for non-authenticated user
        authContainer.classList.remove('hidden');
        dashboardContainer.classList.add('hidden');
    }
}); 