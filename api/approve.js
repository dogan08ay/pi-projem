/**
 * Approve.js - Domain Onay Sistemi
 * index-enhanced.html ile çalışan tam onay yönetim kodu
 */

// ============================================
// VERITABANI SİMÜLASYONU (Gerçek projede Firebase/Backend ile değiştirilecek)
// ============================================

const mockDatabase = {
    pendingRequests: [
        {
            id: 1,
            domainName: 'example.pi',
            price: 100,
            type: 'teknoloji',
            description: 'Teknoloji şirketi için domain',
            submittedBy: 'user123',
            sellerWallet: '0x1234...5678',
            status: 'pending',
            submittedAt: new Date(Date.now() - 3600000),
        },
        {
            id: 2,
            domainName: 'shop.pi',
            price: 150,
            type: 'eticaret',
            description: 'E-ticaret platformu',
            submittedBy: 'seller456',
            sellerWallet: '0xabcd...efgh',
            status: 'pending',
            submittedAt: new Date(Date.now() - 7200000),
        },
    ],
    approvedDomains: [],
    notifications: [],
};

// ============================================
// ONAY FONKSİYONLARI
// ============================================

/**
 * Bekleyen onay taleplerini getir
 */
function getPendingRequests() {
    return mockDatabase.pendingRequests.filter(r => r.status === 'pending');
}

/**
 * Tüm onaylı domainleri getir
 */
function getApprovedDomains() {
    return mockDatabase.approvedDomains;
}

/**
 * Domain onay talebini onayla
 * @param {number} requestId - Onay talep ID'si
 * @param {object} adminData - Admin bilgileri
 */
function approveDomainRequest(requestId, adminData = {}) {
    const request = mockDatabase.pendingRequests.find(r => r.id === requestId);
    
    if (!request) {
        console.error(`Onay talebi bulunamadı: ${requestId}`);
        return { success: false, error: 'Request not found' };
    }

    if (request.status !== 'pending') {
        console.error(`Bu talep zaten işlendi: ${request.status}`);
        return { success: false, error: 'Request already processed' };
    }

    try {
        // Onay talebini güncelle
        request.status = 'approved';
        request.approvedAt = new Date();
        request.approvedBy = adminData.name || 'Admin';

        // Onaylı domainler listesine ekle
        mockDatabase.approvedDomains.push({
            ...request,
            status: 'active',
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        // Bildirim oluştur
        createNotification({
            userId: request.submittedBy,
            title: '✅ Domain Onaylandı',
            body: `"${request.domainName}" başarıyla onaylandı ve satışa sunuldu.`,
            type: 'approval',
            relatedDomain: request.domainName,
        });

        // Admin için bildirim
        createNotification({
            userId: 'admin',
            title: '🎯 Domain Onaylandı',
            body: `${request.submittedBy} tarafından gönderilen "${request.domainName}" onaylandı.`,
            type: 'approval',
            relatedDomain: request.domainName,
        });

        console.log(`✅ Domain onaylandı: ${request.domainName}`);
        return { success: true, domain: request };
    } catch (error) {
        console.error('Onay işlemi sırasında hata:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Domain onay talebini reddet
 * @param {number} requestId - Onay talep ID'si
 * @param {string} reason - Ret nedeni
 */
function rejectDomainRequest(requestId, reason = '') {
    const request = mockDatabase.pendingRequests.find(r => r.id === requestId);
    
    if (!request) {
        console.error(`Onay talebi bulunamadı: ${requestId}`);
        return { success: false, error: 'Request not found' };
    }

    try {
        request.status = 'rejected';
        request.rejectedAt = new Date();
        request.rejectionReason = reason;

        // Bildirim oluştur
        createNotification({
            userId: request.submittedBy,
            title: '❌ Domain Reddedildi',
            body: `"${request.domainName}" onay talebiniz reddedildi.${reason ? ` Neden: ${reason}` : ''}`,
            type: 'other',
            relatedDomain: request.domainName,
        });

        console.log(`❌ Domain reddedildi: ${request.domainName}`);
        return { success: true };
    } catch (error) {
        console.error('Red işlemi sırasında hata:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Domain'i satıştan kaldır
 * @param {number} domainId - Domain ID'si
 */
function removeDomainFromSale(domainId) {
    const domainIndex = mockDatabase.approvedDomains.findIndex(d => d.id === domainId);
    
    if (domainIndex === -1) {
        console.error(`Domain bulunamadı: ${domainId}`);
        return { success: false, error: 'Domain not found' };
    }

    try {
        const domain = mockDatabase.approvedDomains[domainIndex];
        
        // Tüm ilgili verileri sil
        mockDatabase.approvedDomains.splice(domainIndex, 1);
        
        // Satış geçmişini temizle
        cleanupDomainData(domain.domainName);

        console.log(`🗑️ Domain satıştan kaldırıldı: ${domain.domainName}`);
        return { success: true };
    } catch (error) {
        console.error('Silme işlemi sırasında hata:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Domain'e ait tüm verileri temizle
 * @param {string} domainName - Domain adı
 */
function cleanupDomainData(domainName) {
    // Satış geçmişini temizle
    mockDatabase.purchaseHistory = (mockDatabase.purchaseHistory || [])
        .filter(p => p.domainName !== domainName);

    // Kazanç kayıtlarını temizle
    mockDatabase.earnings = (mockDatabase.earnings || [])
        .filter(e => e.domainName !== domainName);

    // Fiyat hareketlerini temizle
    mockDatabase.priceHistory = (mockDatabase.priceHistory || [])
        .filter(p => p.domainName !== domainName);

    console.log(`🧹 ${domainName} için tüm veriler temizlendi`);
}

// ============================================
// BİLDİRİM SİSTEMİ
// ============================================

/**
 * Bildirim oluştur
 * @param {object} notificationData - Bildirim verisi
 */
function createNotification(notificationData) {
    const notification = {
        id: Date.now(),
        timestamp: new Date(),
        read: false,
        ...notificationData,
    };

    mockDatabase.notifications.push(notification);

    // UI'da güncelle
    updateNotificationBadge();
    
    console.log('📬 Bildirim oluşturuldu:', notification);
    return notification;
}

/**
 * Bildirim rozeti güncelle
 */
function updateNotificationBadge() {
    const unreadCount = mockDatabase.notifications.filter(n => !n.read).length;
    const badge = document.getElementById('notif-badge');
    
    if (badge) {
        badge.textContent = unreadCount;
        badge.style.display = unreadCount > 0 ? 'block' : 'none';
    }

    const btn = document.getElementById('notif-btn');
    if (btn) {
        btn.style.display = unreadCount > 0 ? 'flex' : 'none';
    }
}

/**
 * Tüm bildirimleri getir
 */
function getNotifications() {
    return mockDatabase.notifications.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Bildirimi okundu olarak işaretle
 * @param {number} notificationId - Bildirim ID'si
 */
function markNotificationAsRead(notificationId) {
    const notif = mockDatabase.notifications.find(n => n.id === notificationId);
    if (notif) {
        notif.read = true;
        updateNotificationBadge();
    }
}

/**
 * Tüm bildirimleri okundu olarak işaretle
 */
function markAllNotificationsAsRead() {
    mockDatabase.notifications.forEach(n => n.read = true);
    updateNotificationBadge();
    console.log('✓ Tüm bildirimler okundu olarak işaretlendi');
}

// ============================================
// UI GÜNCELLEMELERİ
// ============================================

/**
 * Bekleyen onaylar listesini UI'da göster
 */
function displayPendingRequests() {
    const pendingList = document.getElementById('pending-list');
    if (!pendingList) return;

    const requests = getPendingRequests();

    if (requests.length === 0) {
        pendingList.innerHTML = '<p style="color:#94a3b8;font-size:0.85em;">Bekleyen onay yok.</p>';
        return;
    }

    pendingList.innerHTML = requests.map(req => `
        <div class="pending-domain-item">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                <div>
                    <div style="font-weight:900;color:#fbbf24;font-size:0.9em;">${req.domainName}</div>
                    <div style="font-size:0.75em;color:#94a3b8;margin-top:2px;">
                        👤 ${req.submittedBy} • 💰 ${req.price} PI
                    </div>
                </div>
                <button class="btn-detail" onclick="showDetailModal(${req.id})">📋 Detay</button>
            </div>
            <div style="font-size:0.75em;color:#cbd5e1;margin-bottom:8px;line-height:1.4;">
                ${req.description || 'Açıklama girilmemiş'}
            </div>
            <div style="display:flex;gap:6px;">
                <button class="btn-primary" onclick="handleApprove(${req.id})" style="flex:1;padding:6px;font-size:0.75em;margin-top:0;">✓ ONAYLA</button>
                <button class="btn-danger" onclick="handleReject(${req.id})" style="flex:1;padding:6px;font-size:0.75em;margin-top:0;">✕ REDDET</button>
            </div>
        </div>
    `).join('');
}

/**
 * Detay modalını göster
 * @param {number} requestId - Onay talep ID'si
 */
function showDetailModal(requestId) {
    const request = mockDatabase.pendingRequests.find(r => r.id === requestId);
    if (!request) return;

    const modal = document.getElementById('detail-modal');
    const content = document.getElementById('detail-content');

    content.innerHTML = `
        <div class="detail-row">
            <span class="detail-label">🌐 Domain</span>
            <span class="detail-value">${request.domainName}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">💰 Fiyat</span>
            <span class="detail-value">${request.price} PI</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">🏷️ Kategori</span>
            <span class="detail-value">${request.type}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">👤 Gönderen</span>
            <span class="detail-value">@${request.submittedBy}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">💳 Cüzdan</span>
            <span class="detail-value">${request.sellerWallet || 'Belirtilmemiş'}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">📝 Açıklama</span>
            <span class="detail-value">${request.description || 'Açıklama girilmemiş'}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">⏰ Gönderildi</span>
            <span class="detail-value">${request.submittedAt.toLocaleString()}</span>
        </div>
        <button class="btn-primary" onclick="handleApprove(${request.id})" style="margin-top:12px;">✓ ONAYLA</button>
        <button class="btn-danger" onclick="handleReject(${request.id})" style="margin-top:6px;">✕ REDDET</button>
    `;

    modal.classList.add('active');
}

/**
 * Onay işlemini gerçekleştir
 * @param {number} requestId - Onay talep ID'si
 */
function handleApprove(requestId) {
    const result = approveDomainRequest(requestId, { name: 'Admin' });

    if (result.success) {
        alert('✅ Domain başarıyla onaylandı ve satışa sunuldu!');
        document.getElementById('detail-modal').classList.remove('active');
        displayPendingRequests();
        displayAdminStats();
    } else {
        alert(`❌ Hata: ${result.error}`);
    }
}

/**
 * Red işlemini gerçekleştir
 * @param {number} requestId - Onay talep ID'si
 */
function handleReject(requestId) {
    const reason = prompt('Red nedenini giriniz (opsiyonel):');
    const result = rejectDomainRequest(requestId, reason || '');

    if (result.success) {
        alert('❌ Domain onay talebi reddedildi.');
        document.getElementById('detail-modal').classList.remove('active');
        displayPendingRequests();
    } else {
        alert(`Hata: ${result.error}`);
    }
}

// ============================================
// ADMIN İSTATİSTİKLERİ
// ============================================

/**
 * Admin istatistiklerini göster
 */
function displayAdminStats() {
    const statsDiv = document.getElementById('admin-stats');
    if (!statsDiv) return;

    const pending = getPendingRequests().length;
    const approved = getApprovedDomains().length;
    const totalEarnings = getApprovedDomains().reduce((sum, d) => sum + d.price, 0);

    statsDiv.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
            <div class="earnings-box" style="background:rgba(99,102,241,0.2);border-color:#6366f1;">
                <div class="earnings-value" style="color:#818cf8;">${pending}</div>
                <div class="earnings-label">Bekleyen Onay</div>
            </div>
            <div class="earnings-box" style="background:rgba(16,185,129,0.2);border-color:#10b981;">
                <div class="earnings-value" style="color:#6ee7b7;">${approved}</div>
                <div class="earnings-label">Onaylı Domain</div>
            </div>
        </div>
        <div class="earnings-box">
            <div class="earnings-value">${totalEarnings} PI</div>
            <div class="earnings-label">Toplam Kazanç</div>
        </div>
    `;
}

/**
 * Admin kazanç detaylarını göster
 */
function displayAdminEarnings() {
    const earningsDiv = document.getElementById('admin-earnings-content');
    if (!earningsDiv) return;

    const domains = getApprovedDomains();

    if (domains.length === 0) {
        earningsDiv.innerHTML = '<p style="color:#94a3b8;font-size:0.85em;">Henüz onaylı domain yok.</p>';
        return;
    }

    earningsDiv.innerHTML = domains.map(d => `
        <div class="sell-request-item">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <span style="font-weight:900;color:#fbbf24;">${d.domainName}</span>
                <span style="font-size:0.85em;color:#34d399;font-weight:900;">${d.price} PI</span>
            </div>
            <div style="font-size:0.75em;color:#94a3b8;">
                👤 ${d.submittedBy} • 📅 ${d.approvedAt?.toLocaleDateString() || 'N/A'}
            </div>
            <button class="btn-danger" onclick="handleRemoveDomain(${d.id})" style="margin-top:6px;padding:4px 8px;font-size:0.7em;">🗑️ Satıştan Kaldır</button>
        </div>
    `).join('');
}

/**
 * Domain'i satıştan kaldır
 * @param {number} domainId - Domain ID'si
 */
function handleRemoveDomain(domainId) {
    if (confirm('Bu domain'i satıştan kaldırmak istediğinize emin misiniz? Tüm veriler silinecektir.')) {
        const result = removeDomainFromSale(domainId);
        if (result.success) {
            alert('✓ Domain satıştan kaldırıldı ve tüm veriler silindi.');
            displayAdminEarnings();
            displayAdminStats();
        } else {
            alert(`Hata: ${result.error}`);
        }
    }
}

// ============================================
// BİLDİRİM LİSTESİ
// ============================================

/**
 * Bildirim listesini göster
 */
function displayNotifications() {
    const notifList = document.getElementById('notif-list');
    if (!notifList) return;

    const notifications = getNotifications();

    if (notifications.length === 0) {
        notifList.innerHTML = '<p style="color:#94a3b8;font-size:0.85em;">Bildirim yok.</p>';
        return;
    }

    notifList.innerHTML = notifications.map(n => `
        <div class="notif-item ${n.read ? '' : 'unread'}" onclick="markNotificationAsRead(${n.id})">
            <span class="notif-dot ${n.read ? 'read' : ''}"></span>
            <div style="flex:1;">
                <div style="font-weight:900;color:#c7d2fe;font-size:0.85em;">${n.title}</div>
                <div style="font-size:0.75em;color:#94a3b8;margin-top:2px;">${n.body}</div>
                <div style="font-size:0.65em;color:#64748b;margin-top:4px;">${n.timestamp.toLocaleString()}</div>
            </div>
        </div>
    `).join('');
}

// ============================================
// BAŞLATMA FONKSİYONU
// ============================================

/**
 * Tüm admin panelini başlat
 */
function initializeAdminPanel() {
    console.log('🚀 Admin paneli başlatılıyor...');
    
    displayPendingRequests();
    displayAdminStats();
    displayAdminEarnings();
    displayNotifications();
    updateNotificationBadge();

    // Periyodik güncelleme (gerçek projede WebSocket/Firestore listener olacak)
    setInterval(() => {
        displayPendingRequests();
        displayAdminStats();
        displayNotifications();
        updateNotificationBadge();
    }, 5000);

    console.log('✅ Admin paneli hazır');
}

// ============================================
// DIŞA AKTAR (Global fonksiyonlar)
// ============================================

window.approveDomainRequest = approveDomainRequest;
window.rejectDomainRequest = rejectDomainRequest;
window.removeDomainFromSale = removeDomainFromSale;
window.createNotification = createNotification;
window.markNotificationAsRead = markNotificationAsRead;
window.markAllNotificationsAsRead = markAllNotificationsAsRead;
window.displayPendingRequests = displayPendingRequests;
window.displayAdminStats = displayAdminStats;
window.displayAdminEarnings = displayAdminEarnings;
window.displayNotifications = displayNotifications;
window.showDetailModal = showDetailModal;
window.handleApprove = handleApprove;
window.handleReject = handleReject;
window.handleRemoveDomain = handleRemoveDomain;
window.initializeAdminPanel = initializeAdminPanel;

// Sayfa yüklendiğinde başlat
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeAdminPanel);
} else {
    initializeAdminPanel();
}
