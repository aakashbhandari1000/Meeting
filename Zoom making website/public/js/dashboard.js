// Get Firebase instances
const { auth, db, rtdb } = window.firebaseApp;

// UI Elements
const newMeetingBtn = document.getElementById('new-meeting');
const joinMeetingBtn = document.getElementById('join-btn');
const newMeetingModal = document.getElementById('new-meeting-modal');
const newMeetingForm = document.getElementById('new-meeting-form');
const modalCloseButtons = document.querySelectorAll('.modal-close');
const scheduledMeetingsGrid = document.getElementById('scheduled-meetings');
const recentMeetingsGrid = document.getElementById('recent-meetings');

// Helper Functions
function generateMeetingId() {
    return Math.random().toString(36).substring(2, 12);
}

function formatDate(date) {
    return new Date(date).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
}

function formatTime(time) {
    return new Date(`2000-01-01T${time}`).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

// Create Meeting Card
function createMeetingCard(meeting) {
    const card = document.createElement('div');
    card.className = 'meeting-card';
    
    const status = meeting.endTime < new Date().toISOString() ? 'Ended' : 'Scheduled';
    const statusClass = status === 'Ended' ? 'text-muted' : 'text-success';
    
    card.innerHTML = `
        <div class="meeting-card-header">
            <h3>${meeting.title}</h3>
            <span class="meeting-date">${formatDate(meeting.startTime)}</span>
        </div>
        <div class="meeting-card-content">
            <p>
                <i class="fas fa-clock"></i>
                ${formatTime(meeting.startTime.split('T')[1])} - ${formatTime(meeting.endTime.split('T')[1])}
            </p>
            <p>
                <i class="fas fa-user-friends"></i>
                ${meeting.participants?.length || 0} Participants
            </p>
            <p>
                <i class="fas fa-key"></i>
                Meeting ID: ${meeting.id}
            </p>
            <p class="${statusClass}">
                <i class="fas fa-circle"></i>
                ${status}
            </p>
        </div>
        <div class="meeting-card-actions">
            <button class="btn-secondary copy-link" data-id="${meeting.id}">
                <i class="fas fa-copy"></i>
                Copy Link
            </button>
            ${status !== 'Ended' ? `
                <button class="btn-primary join-meeting" data-id="${meeting.id}">
                    <i class="fas fa-sign-in-alt"></i>
                    Join
                </button>
            ` : ''}
        </div>
    `;

    // Add event listeners
    card.querySelector('.copy-link').addEventListener('click', () => {
        const meetingLink = `${window.location.origin}/meeting.html?id=${meeting.id}`;
        navigator.clipboard.writeText(meetingLink);
        showToast('Meeting link copied to clipboard!');
    });

    const joinBtn = card.querySelector('.join-meeting');
    if (joinBtn) {
        joinBtn.addEventListener('click', () => {
            window.location.href = `/meeting.html?id=${meeting.id}`;
        });
    }

    return card;
}

// Show Toast Message
function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.remove();
    }, 3000);
}

// Load User's Meetings
async function loadMeetings() {
    try {
        const userId = auth.currentUser.uid;
        
        // Load scheduled meetings
        const scheduledMeetingsQuery = query(
            collection(db, 'meetings'),
            where('hostId', '==', userId),
            where('endTime', '>', new Date().toISOString()),
            orderBy('endTime', 'asc')
        );
        
        const scheduledSnapshot = await getDocs(scheduledMeetingsQuery);
        scheduledMeetingsGrid.innerHTML = '';
        scheduledSnapshot.forEach(doc => {
            const meeting = { id: doc.id, ...doc.data() };
            scheduledMeetingsGrid.appendChild(createMeetingCard(meeting));
        });
        
        // Load recent meetings
        const recentMeetingsQuery = query(
            collection(db, 'meetings'),
            where('hostId', '==', userId),
            where('endTime', '<=', new Date().toISOString()),
            orderBy('endTime', 'desc'),
            limit(5)
        );
        
        const recentSnapshot = await getDocs(recentMeetingsQuery);
        recentMeetingsGrid.innerHTML = '';
        recentSnapshot.forEach(doc => {
            const meeting = { id: doc.id, ...doc.data() };
            recentMeetingsGrid.appendChild(createMeetingCard(meeting));
        });
    } catch (error) {
        console.error('Error loading meetings:', error);
        showToast('Error loading meetings');
    }
}

// Event Listeners
newMeetingBtn.addEventListener('click', () => {
    newMeetingModal.classList.remove('hidden');
    
    // Set default date and time
    const now = new Date();
    const dateInput = document.getElementById('meeting-date');
    const timeInput = document.getElementById('meeting-time');
    
    dateInput.value = now.toISOString().split('T')[0];
    timeInput.value = now.toTimeString().slice(0, 5);
});

modalCloseButtons.forEach(button => {
    button.addEventListener('click', () => {
        const modal = button.closest('.modal');
        modal.classList.add('hidden');
    });
});

newMeetingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    try {
        const title = document.getElementById('meeting-title').value;
        const date = document.getElementById('meeting-date').value;
        const time = document.getElementById('meeting-time').value;
        const duration = document.getElementById('meeting-duration').value;
        const password = document.getElementById('meeting-password').value;
        const waitingRoom = document.getElementById('waiting-room').checked;
        
        const startTime = new Date(`${date}T${time}`).toISOString();
        const endTime = new Date(`${date}T${time}`);
        endTime.setMinutes(endTime.getMinutes() + parseInt(duration));
        
        const meetingId = generateMeetingId();
        const userId = auth.currentUser.uid;
        
        // Create meeting in Firestore
        await setDoc(doc(db, 'meetings', meetingId), {
            id: meetingId,
            title,
            hostId: userId,
            startTime,
            endTime: endTime.toISOString(),
            password: password || null,
            waitingRoom,
            participants: [],
            settings: {
                muteOnEntry: true,
                allowChat: true,
                allowScreenShare: true,
                allowRecording: true
            },
            createdAt: new Date().toISOString()
        });
        
        // Create meeting room in RTDB
        await set(ref(rtdb, `rooms/${meetingId}`), {
            status: 'waiting',
            activeParticipants: 0,
            chat: [],
            reactions: []
        });
        
        showToast('Meeting created successfully!');
        newMeetingModal.classList.add('hidden');
        loadMeetings();
    } catch (error) {
        console.error('Error creating meeting:', error);
        showToast('Error creating meeting');
    }
});

joinMeetingBtn.addEventListener('click', () => {
    const meetingId = document.getElementById('join-id').value.trim();
    if (meetingId) {
        window.location.href = `/meeting.html?id=${meetingId}`;
    } else {
        showToast('Please enter a meeting ID');
    }
});

// Initialize
if (auth.currentUser) {
    loadMeetings();
} 