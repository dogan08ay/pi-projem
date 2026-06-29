import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Bell, LogOut, ChevronRight } from "lucide-react";

// i18n translations
const translations = {
  tr: {
    dashboard: "Kontrol Paneli",
    notifications: "Bildirimler",
    profile: "Profil",
    overview: "Genel",
    purchases: "Alımlarım",
    listings: "İlanlarım",
    earnings: "Gelirim",
    admin: "Admin",
    markAllRead: "Tümünü Okundu Yap",
    noNotifications: "Henüz bildiriminiz yok.",
    purchasedDomains: "Satın Alınan Domainler",
    noPurchases: "Henüz satın alma geçmişiniz bulunmuyor.",
    myListings: "Satış İlanlarım",
    newListing: "+ Yeni İlan Ver",
    noListings: "Henüz satışa sunduğunuz bir domain yok.",
    onSale: "Satışta",
    sold: "Satıldı",
    pendingApproval: "⏳ Onay Bekliyor",
    approved: "✅ Onaylandı",
    totalEarnings: "Toplam Kazanç",
    earningsNote: "Satışa sunduğunuz ve satılan domainlerden elde edilen gelir.",
    adminPanel: "Admin Paneli",
    pendingApprovals: "Bekleyen Onaylar",
    adminEarnings: "Kazançlar",
    noPending: "Bekleyen domain önerisi yok.",
    approve: "✓ Onayla",
    reject: "✕ Reddet",
    details: "📋 Detaylar",
    domainName: "Domain Adı",
    price: "Fiyat",
    type: "Tür",
    submittedBy: "Gönderen",
    wallet: "Cüzdan",
    description: "Açıklama",
    listDomain: "Domainini Satışa Çıkar",
    domainNamePlaceholder: "domain.pi",
    pricePlaceholder: "100",
    categoryPlaceholder: "Kategori Seçin",
    descriptionPlaceholder: "Domain hakkında kısa açıklama...",
    walletPlaceholder: "G... ile başlayan cüzdan adresin",
    sendForApproval: "ONAYA GÖNDER",
    cancel: "VAZGEÇ",
    username: "Kullanıcı Adı",
    email: "E-posta",
    signOut: "Çıkış Yap",
    general: "Genel",
    finance: "Finans / Bankacılık",
    ecommerce: "E-Ticaret",
    personal: "Kişisel İsim",
    technology: "Teknoloji",
    tourism: "Turizm / Seyahat",
    financialServices: "Faizsiz Finansal Hizmetler",
    health: "Sağlık",
    education: "Eğitim",
    media: "Medya",
    sports: "Spor",
    other: "Diğer",
    info: "BİLGİ",
    testNetNote: "Bu uygulama Test-Pi ağında deneme amaçlıdır. Satın aldığınız domainler, diğer kullanıcıların da test yapabilmesi için markette tekrar SATIN AL olarak görünebilir ve satın alma geçmişinizden silinebilir.",
  },
  en: {
    dashboard: "Dashboard",
    notifications: "Notifications",
    profile: "Profile",
    overview: "Overview",
    purchases: "My Purchases",
    listings: "My Listings",
    earnings: "My Income",
    admin: "Admin",
    markAllRead: "Mark All Read",
    noNotifications: "No notifications yet.",
    purchasedDomains: "Purchased Domains",
    noPurchases: "No purchase history found yet.",
    myListings: "My Domain Listings",
    newListing: "+ New Listing",
    noListings: "You haven't listed any domains yet.",
    onSale: "On Sale",
    sold: "Sold",
    pendingApproval: "⏳ Pending Approval",
    approved: "✅ Approved",
    totalEarnings: "Total Earnings",
    earningsNote: "Total earnings from your listed and sold domains.",
    adminPanel: "Admin Panel",
    pendingApprovals: "Pending Approvals",
    adminEarnings: "Earnings",
    noPending: "No pending domain submissions.",
    approve: "✓ Approve",
    reject: "✕ Reject",
    details: "📋 Details",
    domainName: "Domain Name",
    price: "Price",
    type: "Type",
    submittedBy: "Submitted By",
    wallet: "Wallet",
    description: "Description",
    listDomain: "List Your Domain for Sale",
    domainNamePlaceholder: "domain.pi",
    pricePlaceholder: "100",
    categoryPlaceholder: "Select Category",
    descriptionPlaceholder: "Short description about the domain...",
    walletPlaceholder: "Your wallet address starting with G...",
    sendForApproval: "SEND FOR APPROVAL",
    cancel: "CANCEL",
    username: "Username",
    email: "Email",
    signOut: "Sign Out",
    general: "General",
    finance: "Finance / Banking",
    ecommerce: "E-Commerce",
    personal: "Personal Name",
    technology: "Technology",
    tourism: "Tourism / Travel",
    financialServices: "Interest-Free Financial Services",
    health: "Health",
    education: "Education",
    media: "Media",
    sports: "Sports",
    other: "Other",
    info: "INFO",
    testNetNote: "This app runs on Test-Pi for demo purposes. Purchased domains may reappear as BUY and may be removed from your history.",
  },
};

type Language = "tr" | "en";

export default function EnhancedDashboard() {
  const { user, logout } = useAuth();
  const [lang, setLang] = useState<Language>("tr");
  const [activeTab, setActiveTab] = useState("overview");
  const [isAdmin, setIsAdmin] = useState(false);
  const [showSellModal, setShowSellModal] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<any>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  const t = (key: keyof typeof translations.tr) => translations[lang][key] || key;

  // Fetch data
  const { data: categories } = trpc.domains.getCategories.useQuery();
  const { data: earnings } = trpc.domains.getUserTotalEarnings.useQuery();
  const { data: notifications } = trpc.notifications.getNotifications.useQuery();
  const { data: pendingRequests } = trpc.domains.getPendingRequests.useQuery(undefined, {
    enabled: isAdmin,
  });
  const { data: userRequests } = trpc.domains.getUserRequests.useQuery();
  const { data: purchases } = trpc.domains.getUserPurchases.useQuery();

  // Mutations
  const submitSellMutation = trpc.domains.submitForSale.useMutation();
  const approveMutation = trpc.domains.approveSellRequest.useMutation();
  const markAllReadMutation = trpc.notifications.markAllAsRead.useMutation();

  useEffect(() => {
    if (user?.role === "admin") {
      setIsAdmin(true);
    }
  }, [user]);

  useEffect(() => {
    if (notifications) {
      const unread = notifications.filter((n) => !n.read).length;
      setUnreadCount(unread);
    }
  }, [notifications]);

  const handleSubmitSell = async (formData: any) => {
    try {
      await submitSellMutation.mutateAsync(formData);
      setShowSellModal(false);
    } catch (error) {
      console.error("Error submitting sell request:", error);
    }
  };

  const handleApprove = async (requestId: number) => {
    try {
      await approveMutation.mutateAsync({ requestId });
    } catch (error) {
      console.error("Error approving request:", error);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllReadMutation.mutateAsync();
    } catch (error) {
      console.error("Error marking notifications as read:", error);
    }
  };

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-900">
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader>
            <CardTitle>{t("profile")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-slate-300">Lütfen devam etmek için giriş yapın.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">{t("dashboard")}</h1>
          <div className="flex gap-2">
            <button
              onClick={() => setShowNotifications(!showNotifications)}
              className="relative p-2 hover:bg-slate-800 rounded-lg transition"
            >
              <Bell size={24} />
              {unreadCount > 0 && (
                <Badge className="absolute -top-1 -right-1 bg-red-500 text-xs">
                  {unreadCount}
                </Badge>
              )}
            </button>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as Language)}
              className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm"
            >
              <option value="tr">🇹🇷 TR</option>
              <option value="en">🇬🇧 EN</option>
            </select>
            <button onClick={logout} className="p-2 hover:bg-slate-800 rounded-lg transition">
              <LogOut size={24} />
            </button>
          </div>
        </div>

        {/* Notifications Panel */}
        {showNotifications && (
          <Card className="mb-6 bg-slate-800 border-slate-700">
            <CardHeader>
              <div className="flex justify-between items-center">
                <CardTitle>{t("notifications")}</CardTitle>
                <Button size="sm" onClick={handleMarkAllRead} variant="outline">
                  {t("markAllRead")}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {notifications && notifications.length > 0 ? (
                  notifications.map((notif) => (
                    <div
                      key={notif.id}
                      className={`p-3 rounded-lg border transition ${
                        notif.read
                          ? "bg-slate-700 border-slate-600"
                          : "bg-indigo-900 border-indigo-500"
                      }`}
                    >
                      <p className="font-semibold text-sm">{notif.title}</p>
                      <p className="text-xs text-slate-300 mt-1">{notif.body}</p>
                      <p className="text-xs text-slate-500 mt-2">
                        {new Date(notif.createdAt).toLocaleDateString(lang === "tr" ? "tr-TR" : "en-GB")}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="text-slate-400 text-sm">{t("noNotifications")}</p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Main Content */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-slate-800 border-slate-700 grid w-full" style={{ gridTemplateColumns: `repeat(${isAdmin ? 5 : 4}, 1fr)` }}>
            <TabsTrigger value="overview">{t("overview")}</TabsTrigger>
            <TabsTrigger value="purchases">{t("purchases")}</TabsTrigger>
            <TabsTrigger value="listings">{t("listings")}</TabsTrigger>
            <TabsTrigger value="earnings">{t("earnings")}</TabsTrigger>
            {isAdmin && <TabsTrigger value="admin">{t("admin")}</TabsTrigger>}
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-4">
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle>{t("profile")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm text-slate-400">{t("username")}</p>
                  <p className="text-lg font-semibold">@{user.name}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-400">{t("email")}</p>
                  <p className="text-lg font-semibold">{user.email}</p>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle>{t("info")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-300 whitespace-pre-wrap">{t("testNetNote")}</p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Purchases Tab */}
          <TabsContent value="purchases">
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle>{t("purchasedDomains")}</CardTitle>
              </CardHeader>
              <CardContent>
                {purchases && purchases.length > 0 ? (
                  <div className="space-y-2">
                    {purchases.map((purchase) => (
                      <div key={purchase.id} className="p-4 bg-slate-700 rounded-lg border border-slate-600 hover:border-slate-500 transition">
                        <div className="flex justify-between items-start">
                          <div>
                            <p className="font-semibold">{purchase.domainName}</p>
                            <p className="text-sm text-slate-400">
                              {new Date(purchase.purchasedAt).toLocaleDateString(lang === "tr" ? "tr-TR" : "en-GB")}
                            </p>
                          </div>
                          <Badge variant="secondary">{purchase.price} PI</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-slate-400 text-center py-8">{t("noPurchases")}</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Listings Tab */}
          <TabsContent value="listings">
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <div className="flex justify-between items-center">
                  <CardTitle>{t("myListings")}</CardTitle>
                  <Button onClick={() => setShowSellModal(true)}>{t("newListing")}</Button>
                </div>
              </CardHeader>
              <CardContent>
                {userRequests && userRequests.length > 0 ? (
                  <div className="space-y-2">
                    {userRequests.map((request) => (
                      <div key={request.id} className="p-4 bg-slate-700 rounded-lg border border-slate-600 hover:border-slate-500 transition">
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <p className="font-semibold">{request.domainName}</p>
                            <p className="text-sm text-slate-400 mt-1">{request.price} PI</p>
                            <p className="text-xs text-slate-500 mt-2">{request.type}</p>
                          </div>
                          <Badge
                            variant={request.status === "approved" ? "default" : "secondary"}
                            className={request.status === "approved" ? "bg-green-600" : "bg-yellow-600"}
                          >
                            {request.status === "approved" ? t("approved") : t("pendingApproval")}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-slate-400 text-center py-8">{t("noListings")}</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Earnings Tab */}
          <TabsContent value="earnings">
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle>{t("totalEarnings")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="bg-gradient-to-r from-green-900 to-green-800 rounded-lg p-6 border border-green-700 mb-4">
                  <p className="text-4xl font-bold text-green-400">{earnings || "0"} PI</p>
                </div>
                <p className="text-sm text-slate-400">{t("earningsNote")}</p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Admin Tab */}
          {isAdmin && (
            <TabsContent value="admin" className="space-y-4">
              <Tabs defaultValue="pending" className="w-full">
                <TabsList className="bg-slate-800 border-slate-700 grid w-full grid-cols-2">
                  <TabsTrigger value="pending">{t("pendingApprovals")}</TabsTrigger>
                  <TabsTrigger value="earnings">{t("adminEarnings")}</TabsTrigger>
                </TabsList>

                <TabsContent value="pending">
                  <Card className="bg-slate-800 border-slate-700">
                    <CardHeader>
                      <CardTitle>{t("pendingApprovals")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {pendingRequests && pendingRequests.length > 0 ? (
                        <div className="space-y-2">
                          {pendingRequests.map((request) => (
                            <div
                              key={request.id}
                              className="p-4 bg-slate-700 rounded-lg border border-yellow-600 hover:border-yellow-500 transition"
                            >
                              <div className="flex justify-between items-start mb-3">
                                <div className="flex-1">
                                  <p className="font-semibold">{request.domainName}</p>
                                  <p className="text-sm text-slate-400">@{request.submittedBy}</p>
                                </div>
                                <Badge variant="outline">{request.price} PI</Badge>
                              </div>
                              {request.description && (
                                <p className="text-sm text-slate-300 mb-3">{request.description}</p>
                              )}
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    setSelectedRequest(request);
                                    setShowDetailModal(true);
                                  }}
                                  variant="outline"
                                >
                                  {t("details")}
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => handleApprove(request.id)}
                                  className="bg-green-600 hover:bg-green-700"
                                >
                                  {t("approve")}
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-slate-400 text-center py-8">{t("noPending")}</p>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="earnings">
                  <Card className="bg-slate-800 border-slate-700">
                    <CardHeader>
                      <CardTitle>{t("adminEarnings")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-slate-400">Admin kazanç istatistikleri burada görüntülenecek.</p>
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </TabsContent>
          )}
        </Tabs>
      </div>

      {/* Sell Domain Modal */}
      <Dialog open={showSellModal} onOpenChange={setShowSellModal}>
        <DialogContent className="bg-slate-800 border-slate-700">
          <DialogHeader>
            <DialogTitle>{t("listDomain")}</DialogTitle>
          </DialogHeader>
          <SellDomainForm
            categories={categories}
            onSubmit={handleSubmitSell}
            onClose={() => setShowSellModal(false)}
            lang={lang}
            t={t}
          />
        </DialogContent>
      </Dialog>

      {/* Detail Modal */}
      <Dialog open={showDetailModal} onOpenChange={setShowDetailModal}>
        <DialogContent className="bg-slate-800 border-slate-700">
          <DialogHeader>
            <DialogTitle>{t("details")}</DialogTitle>
          </DialogHeader>
          {selectedRequest && (
            <div className="space-y-3">
              <DetailRow label={t("domainName")} value={selectedRequest.domainName} />
              <DetailRow label={t("price")} value={`${selectedRequest.price} PI`} />
              <DetailRow label={t("type")} value={selectedRequest.type} />
              <DetailRow label={t("submittedBy")} value={`@${selectedRequest.submittedBy}`} />
              <DetailRow label={t("wallet")} value={selectedRequest.sellerWallet || "—"} />
              <DetailRow label={t("description")} value={selectedRequest.description || "—"} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-start p-3 bg-slate-700 rounded-lg border border-slate-600">
      <span className="font-semibold text-slate-300">{label}</span>
      <span className="text-slate-200 text-right break-words">{value}</span>
    </div>
  );
}

function SellDomainForm({ categories, onSubmit, onClose, lang, t }: any) {
  const [formData, setFormData] = useState({
    domainName: "",
    price: "",
    type: "genel",
    description: "",
    sellerWallet: "",
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      ...formData,
      price: parseFloat(formData.price),
    });
    onClose();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="text-sm font-medium">{t("domainName")}</label>
        <Input
          placeholder={t("domainNamePlaceholder")}
          value={formData.domainName}
          onChange={(e) => setFormData({ ...formData, domainName: e.target.value })}
          className="bg-slate-700 border-slate-600"
          required
        />
      </div>

      <div>
        <label className="text-sm font-medium">{t("price")}</label>
        <Input
          type="number"
          placeholder={t("pricePlaceholder")}
          value={formData.price}
          onChange={(e) => setFormData({ ...formData, price: e.target.value })}
          className="bg-slate-700 border-slate-600"
          required
        />
      </div>

      <div>
        <label className="text-sm font-medium">{t("type")}</label>
        <Select value={formData.type} onValueChange={(value) => setFormData({ ...formData, type: value })}>
          <SelectTrigger className="bg-slate-700 border-slate-600">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-slate-700 border-slate-600">
            {categories?.map((cat: any) => (
              <SelectItem key={cat.key} value={cat.key}>
                {lang === "tr" ? cat.labelTr : cat.labelEn}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="text-sm font-medium">{t("description")}</label>
        <Textarea
          placeholder={t("descriptionPlaceholder")}
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          className="bg-slate-700 border-slate-600"
        />
      </div>

      <div>
        <label className="text-sm font-medium">{t("wallet")}</label>
        <Input
          placeholder={t("walletPlaceholder")}
          value={formData.sellerWallet}
          onChange={(e) => setFormData({ ...formData, sellerWallet: e.target.value })}
          className="bg-slate-700 border-slate-600"
        />
      </div>

      <div className="flex gap-2">
        <Button type="submit" className="flex-1 bg-indigo-600 hover:bg-indigo-700">
          {t("sendForApproval")}
        </Button>
        <Button type="button" variant="outline" onClick={onClose} className="flex-1">
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
