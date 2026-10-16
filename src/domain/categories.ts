// Стандартный набор категорий: засевается в каждую новую семью, дальше правится в Mini App.
// description — подсказка для ИИ, что относится к категории.

export interface DefaultCategory {
  code: string;
  name: string;
  emoji: string;
  color: string;
  description: string;
  isSystem?: boolean;
}

export const OTHER_CATEGORY_CODE = "other";

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { code: "groceries", name: "Продукты", emoji: "🛒", color: "#22c55e", description: "еда и напитки для дома из магазинов, пакеты на кассе" },
  { code: "cafe", name: "Кафе и рестораны", emoji: "🍽", color: "#f97316", description: "кафе, рестораны, фастфуд, кофе с собой, доставка готовой еды" },
  { code: "transport", name: "Транспорт", emoji: "🚕", color: "#eab308", description: "такси, общественный транспорт, топливо, парковка, обслуживание авто" },
  { code: "home", name: "Дом и быт", emoji: "🏠", color: "#a16207", description: "бытовая химия, хозтовары, посуда, мебель, ремонт, техника для дома" },
  { code: "health", name: "Здоровье и аптека", emoji: "💊", color: "#ef4444", description: "лекарства, аптека, врачи, анализы, медицинские услуги" },
  { code: "clothes", name: "Одежда и обувь", emoji: "👕", color: "#8b5cf6", description: "одежда, обувь, аксессуары" },
  { code: "entertainment", name: "Развлечения", emoji: "🎉", color: "#ec4899", description: "кино, концерты, игры, хобби, книги, путешествия" },
  { code: "telecom", name: "Связь и подписки", emoji: "📱", color: "#3b82f6", description: "мобильная связь, интернет, ТВ, онлайн-подписки" },
  { code: "beauty", name: "Красота и гигиена", emoji: "💄", color: "#d946ef", description: "косметика, средства гигиены, парикмахерская, салоны" },
  { code: "utilities", name: "Коммунальные услуги", emoji: "💡", color: "#0ea5e9", description: "квартплата, электричество, вода, газ, отопление" },
  { code: "pets", name: "Питомцы", emoji: "🐾", color: "#84cc16", description: "корм, наполнитель, ветеринар, товары для животных" },
  { code: "kids", name: "Дети", emoji: "👶", color: "#14b8a6", description: "детские товары, игрушки, подгузники, кружки и секции" },
  { code: "gifts", name: "Подарки", emoji: "🎁", color: "#f43f5e", description: "подарки, цветы, праздники" },
  { code: OTHER_CATEGORY_CODE, name: "Другое", emoji: "📦", color: "#64748b", description: "всё, что не подходит под другие категории", isSystem: true },
];
