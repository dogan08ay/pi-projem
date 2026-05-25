// Pi SDK'sını tarayıcıda da simüle edebilmek için sandbox modunda başlatıyoruz
Pi.init({ version: "2.0", sandbox: true });

const loginBtn = document.getElementById('login-btn');
const userInfoDiv = document.getElementById('user-info');

// Butona tıklandığında çalışacak olan fonksiyon
loginBtn.addEventListener('click', async () => {
    try {
        // Kullanıcıdan sadece kullanıcı adı bilgisini istiyoruz
        const scopes = ['username'];
        
        // Pi cüzdan giriş penceresini açar
        const authResult = await Pi.authenticate(scopes, onIncompletePaymentFound);
        
        // Bağlantı başarılıysa ekrana yazdırıyoruz
        userInfoDiv.innerHTML = `🎉 Bağlantı Başarılı!<br>Hoş geldin: <strong>@${authResult.user.username}</strong>`;
        loginBtn.style.display = 'none'; // Butonu gizle
        
    } catch (error) {
        console.error("Pi Giriş Hatası:", error);
        userInfoDiv.innerHTML = "❌ Pi Girişi başarısız oldu veya iptal edildi.";
    }
});

// İleride ödeme alırken yarım kalan işlemleri kurtarmak için zorunlu fonksiyon
function onIncompletePaymentFound(payment) {
    console.log("Tamamlanmamış ödeme kaydı:", payment);
}
