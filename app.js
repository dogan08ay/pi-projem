// Pi SDK'sını Pi Browser içerisinde gerçek modda çalışacak şekilde başlatıyoruz
Pi.init({ version: "2.0" });

const loginBtn = document.getElementById('login-btn');
const userInfoDiv = document.getElementById('user-info');

// Kullanıcı butona tıkladığında çalışacak fonksiyon
loginBtn.addEventListener('click', async () => {
    try {
        // Pi kullanıcısından sadece kullanıcı adını talep ediyoruz
        const scopes = ['username'];
        
        // Pi Browser'ın cüzdan yetkilendirme penceresini tetikliyoruz
        const authResult = await Pi.authenticate(scopes, onIncompletePaymentFound);
        
        // Giriş başarılı ise bilgileri ekrana yazdırıyoruz
        userInfoDiv.innerHTML = `🎉 Bağlantı Başarılı!<br>Hoş geldin: <strong>@${authResult.user.username}</strong>`;
        loginBtn.style.display = 'none'; // Giriş butonunu gizle
        
    } catch (error) {
        console.error("Pi Giriş Hatası:", error);
        userInfoDiv.innerHTML = "❌ Pi Girişi başarısız oldu veya iptal edildi.";
    }
});

// İleride Pi ile ödeme alırken yarım kalan işlemleri kurtarmak için zorunlu fonksiyon
function onIncompletePaymentFound(payment) {
    console.log("Tamamlanmamış ödeme kaydı:", payment);
}
