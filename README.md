# ETKİM Genç Tekno Girişimcilik Kampı — Demo Day Jüri Sistemi

Beş jürinin 20 ili yedi kritere göre puanladığı, sonuçların ana ekranda canlı ve
efektli gösterildiği web uygulaması. Bağımlılık yok: Node.js 22.13+ yeterli
(veritabanı Node'un yerleşik SQLite modülü).

## Çalıştırma

1. `.env.example` dosyasını `.env` olarak kopyalayın, `ADMIN_SIFRE` ve `JURI_SIFRE` değerlerini yazın.
2. `baslat.bat` (ya da `npm start`).

| Adres | Ne |
|---|---|
| `http://localhost:3000/` | Ana ekran: canlı sıralama, giriş gerekmez |
| `http://localhost:3000/juri` | Jüri paneli (telefona uyumlu): kullanıcı adı isim+soyisim bitişik, küçük harf (ör. `alidemir`) |
| `http://localhost:3000/sonuc` | Sonuç vitrini: oylama bitince ilk üçü sırayla açıklama ekranı |
| `http://localhost:3000/yonetim` | Yönetim paneli: `ADMIN_SIFRE` ile girilir |

## Yönetim paneli

Etkinliğin bütün ayarları `/yonetim` sayfasından yönetilir; kodu düzenlemek ya da sunucuyu
yeniden başlatmak gerekmez. Ayarlar `juri.db` içinde saklanır, açık ekranlar değişince kendini yeniler.

- **Genel Bakış:** oy ilerlemesi, oylamayı açma/kapatma, sahnedeki ili elle seçme, jüri durumu
- **Oylar:** jüri × il tablosu; herhangi bir oyu görüntüleme, düzeltme, silme ya da jüri adına girme
- **İller & Takımlar:** ekleme, çıkarma, yeniden adlandırma, sunum sırasını değiştirme (yeniden adlandırmada oylar korunur)
- **Jüriler:** ekleme, çıkarma, ad / kullanıcı adı değiştirme, jüriye özel şifre, oturumu kapatma
- **Kriterler:** ad, kısa ad, azami puan; oy varken kriter sayısı değişmez, azami puan verilen puanın altına inmez
- **Etkinlik & Logolar:** kurum / program / etkinlik adı, tarih, yer; destekçi logosu yükleme, sıralama, silme
- **Güvenlik & Veri:** ortak jüri şifresi, yönetici şifresi, tüm oturumları kapatma, yedek indirme / geri yükleme, oyları sıfırlama

Panelden belirlenen şifreler `.env` değerlerinin yerine geçer (veritabanında yalnızca scrypt özeti tutulur).
Panelden yüklenen logolar `DATA_DIR/logolar/` klasörüne yazılır.

## Puanlama

Varsayılan kriterler (yönetim panelinden değiştirilebilir):

| Kriter | Puan |
|---|---|
| Girişimcilik (fikrin inovatif yönü) | 1–15 |
| Ekip Kurma Becerisi | 1–10 |
| Yenilikçi Fikirler Sunma ve Ürünler Tasarlayabilme | 1–15 |
| Problem ile Çözüm Uyumu | 1–15 |
| İş Modeli Sürdürülebilir mi? | 1–15 |
| Girişimine Finansman Kaynak Bulma / Yönetme | 1–15 |
| Geliştirilen Fikrin (Girişimin) Sunumu | 1–15 |

Bir jürinin bir ile verebileceği en yüksek puan 100. Ana ekranda puan veren jürilerin
ortalaması gösterilir; ile tıklayınca beş jürinin kriter kriter puanları açılır.
Her jüri kendi puanını istediği zaman değiştirebilir ya da silebilir.

## Ana ekran

- **Şimdi sahnede:** sunum sırası yönetim panelindeki il listesidir. Beş jürinin
  hepsinin oy vermediği ilk il sahnede sayılır; beşi de oy verince ekran sıradaki ile geçer.
  Kartta kaç jürinin oy verdiği ve kimlerin beklendiği görünür. Panelden il seçilirse o il sahnede gösterilir.
- **Sunum bekliyor:** henüz hiç oy almamış iller sıralamada soluk görünür.
- **Alt bant:** panelde girilen etkinlik bilgisi, saat ve destekçi logoları gösterilir.

## Sonuç vitrini

`/sonuc` sayfası podyumda üç gizli kartla açılır. **Açıkla** butonuna (ya da boşluk / → tuşuna)
her basışta sırayla 3., 2. ve 1. açıklanır: kart davul efektiyle titrer, ışık iner, kart döner
ve puan sayarak gelir; birincide taç, ışınlar ve konfeti yağmuru. Sıralama ilk basışta dondurulur,
açıklama sırasında gelen oylar podyumu değiştirmez. `R` baştan alır, `F` tam ekran.
Oylama tamamlanmadıysa sağ üstte kaç oy eksik olduğu uyarısı görünür.

## Puanları indirme (XLSX)

Ana ekrandaki **⬇ XLSX indir** butonu (ya da doğrudan `http://localhost:3000/puanlar.xlsx`)
o anki puanlarla bir Excel dosyası indirir; etkinlik boyunca istenildiği kadar indirilebilir.

- **Sıralama** sayfası: sıra, il, takım, ortalama, oy veren jüri sayısı ve her jürinin toplam puanı
- **Jüri Ayrıntısı** sayfası: sunum sırasına göre her il için beş jürinin kriter kriter puanları,
  oy zamanı ve kriter ortalamaları

Takım isimleri ekranlarda il adının yanında görünür.

## Veri

Oylar ve ayarlar `juri.db` (SQLite) dosyasında. Oyları panelden sıfırlayabilirsiniz; dosyayı silmek
ayarları da `server.js` içindeki varsayılanlara döndürür.
