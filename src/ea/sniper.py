"""
Снайпер - автоматична покупка та продаж
"""

import asyncio
import logging
from typing import Optional, List, Callable, Awaitable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from .client import EAClient, Player, SearchFilter, CaptchaError, RateLimitError, TransferBanError

logger = logging.getLogger(__name__)


class SniperState(Enum):
    STOPPED = "stopped"
    RUNNING = "running"
    PAUSED = "paused"
    ERROR = "error"


@dataclass
class SniperConfig:
    """Конфігурація снайпера"""
    # Затримки (секунди)
    search_interval: float = 3.0
    buy_delay: float = 0.2
    
    # Ліміти
    max_purchases: int = 100
    max_active_sales: int = 50
    min_coins_reserve: int = 10000  # Мінімальний резерв монет
    
    # Продаж
    auto_sell: bool = True
    sell_markup: float = 1.10  # 10% націнка
    sell_duration: int = 3600  # 1 година
    
    # Anti-ban
    pause_after_purchases: int = 5
    pause_duration: float = 30.0
    max_searches_per_hour: int = 500
    
    # Relist
    auto_relist: bool = True
    relist_interval: float = 300.0  # 5 хвилин


@dataclass
class SniperStats:
    """Статистика снайпера"""
    started_at: Optional[datetime] = None
    total_searches: int = 0
    total_purchases: int = 0
    total_sales: int = 0
    total_spent: int = 0
    total_earned: int = 0
    failed_purchases: int = 0
    
    @property
    def profit(self) -> int:
        return self.total_earned - self.total_spent
    
    @property
    def roi(self) -> float:
        if self.total_spent == 0:
            return 0.0
        return (self.profit / self.total_spent) * 100


@dataclass
class SnipeTarget:
    """Ціль для снайпінгу"""
    name: str
    filter: SearchFilter
    max_buy_price: int
    sell_price: Optional[int] = None  # Якщо None - авто
    enabled: bool = True
    priority: int = 1  # Вищий = важливіший
    
    # Статистика по цілі
    searches: int = 0
    found: int = 0
    bought: int = 0
    

class Sniper:
    """
    Автоматичний снайпер
    
    Постійно моніторить ринок і купує карти за вигідною ціною
    """
    
    def __init__(
        self, 
        client: EAClient, 
        config: Optional[SniperConfig] = None,
        on_purchase: Optional[Callable[[Player, int], Awaitable[None]]] = None,
        on_sale: Optional[Callable[[int, int], Awaitable[None]]] = None,
        on_error: Optional[Callable[[Exception], Awaitable[None]]] = None,
    ):
        self.client = client
        self.config = config or SniperConfig()
        
        # Callbacks для Telegram сповіщень
        self.on_purchase = on_purchase
        self.on_sale = on_sale
        self.on_error = on_error
        
        # Стан
        self.state = SniperState.STOPPED
        self.stats = SniperStats()
        self.targets: List[SnipeTarget] = []
        
        # Внутрішні змінні
        self._search_task: Optional[asyncio.Task] = None
        self._relist_task: Optional[asyncio.Task] = None
        self._stop_event = asyncio.Event()
        self._hourly_searches = 0
        self._hour_start = datetime.now()
        
    def add_target(self, target: SnipeTarget):
        """Додати ціль для снайпінгу"""
        self.targets.append(target)
        self.targets.sort(key=lambda t: t.priority, reverse=True)
        logger.info(f"Додано ціль: {target.name} (max: {target.max_buy_price})")
        
    def remove_target(self, name: str):
        """Видалити ціль"""
        self.targets = [t for t in self.targets if t.name != name]
        
    def clear_targets(self):
        """Очистити всі цілі"""
        self.targets.clear()
        
    async def start(self):
        """Запустити снайпер"""
        if self.state == SniperState.RUNNING:
            return
            
        if not self.targets:
            logger.warning("Немає цілей для снайпінгу!")
            return
            
        self.state = SniperState.RUNNING
        self.stats.started_at = datetime.now()
        self._stop_event.clear()
        
        logger.info("🚀 Снайпер запущено!")
        
        # Запускаємо задачі
        self._search_task = asyncio.create_task(self._search_loop())
        
        if self.config.auto_relist:
            self._relist_task = asyncio.create_task(self._relist_loop())
    
    async def stop(self):
        """Зупинити снайпер"""
        if self.state == SniperState.STOPPED:
            return
            
        self.state = SniperState.STOPPED
        self._stop_event.set()
        
        if self._search_task:
            self._search_task.cancel()
            try:
                await self._search_task
            except asyncio.CancelledError:
                pass
                
        if self._relist_task:
            self._relist_task.cancel()
            try:
                await self._relist_task
            except asyncio.CancelledError:
                pass
                
        logger.info("🛑 Снайпер зупинено")
        
    async def pause(self):
        """Пауза"""
        self.state = SniperState.PAUSED
        logger.info("⏸️ Снайпер на паузі")
        
    async def resume(self):
        """Продовжити"""
        self.state = SniperState.RUNNING
        logger.info("▶️ Снайпер продовжено")
        
    async def _search_loop(self):
        """Основний цикл пошуку"""
        consecutive_purchases = 0
        
        while not self._stop_event.is_set():
            try:
                if self.state != SniperState.RUNNING:
                    await asyncio.sleep(1)
                    continue
                    
                # Перевіряємо ліміти
                if not await self._check_limits():
                    await asyncio.sleep(5)
                    continue
                
                # Перебираємо цілі
                for target in self.targets:
                    if not target.enabled:
                        continue
                        
                    if self._stop_event.is_set():
                        break
                    
                    # Пошук
                    bought = await self._search_and_buy(target)
                    
                    if bought:
                        consecutive_purchases += 1
                        
                        # Пауза після серії покупок (anti-ban)
                        if consecutive_purchases >= self.config.pause_after_purchases:
                            logger.info(f"⏸️ Пауза {self.config.pause_duration}с після {consecutive_purchases} покупок")
                            await asyncio.sleep(self.config.pause_duration)
                            consecutive_purchases = 0
                    
                    # Затримка між пошуками
                    await asyncio.sleep(self.config.search_interval)
                    
            except CaptchaError:
                self.state = SniperState.ERROR
                logger.error("❌ Потрібна капча! Зупинено.")
                if self.on_error:
                    await self.on_error(CaptchaError("Captcha required"))
                break
                
            except TransferBanError:
                self.state = SniperState.ERROR
                logger.error("❌ Transfer market бан!")
                if self.on_error:
                    await self.on_error(TransferBanError("Transfer ban"))
                break
                
            except RateLimitError:
                logger.warning("⚠️ Rate limit, пауза 60с...")
                await asyncio.sleep(60)
                
            except Exception as e:
                logger.error(f"Search loop error: {e}")
                await asyncio.sleep(5)
    
    async def _search_and_buy(self, target: SnipeTarget) -> bool:
        """Пошук і покупка для конкретної цілі"""
        target.searches += 1
        self.stats.total_searches += 1
        self._hourly_searches += 1
        
        # Пошук
        players = await self.client.search(target.filter)
        
        if not players:
            return False
            
        # Фільтруємо по ціні
        snipeable = [
            p for p in players 
            if p.buy_now_price > 0 and p.buy_now_price <= target.max_buy_price
        ]
        
        if snipeable:
            target.found += len(snipeable)
            logger.info(f"🎯 Знайдено {len(snipeable)} карт для '{target.name}'!")
            
        for player in snipeable:
            # Перевіряємо чи вистачає монет
            coins = await self.client.get_credits()
            if coins < player.buy_now_price + self.config.min_coins_reserve:
                logger.warning(f"Недостатньо монет ({coins})")
                break
                
            # Пробуємо купити
            success = await self.client.buy_now(player.trade_id, player.buy_now_price)
            
            if success:
                target.bought += 1
                self.stats.total_purchases += 1
                self.stats.total_spent += player.buy_now_price
                
                logger.info(
                    f"✅ КУПЛЕНО: {player.name} ({player.rating}) "
                    f"за {player.buy_now_price:,} монет!"
                )
                
                # Callback для Telegram
                if self.on_purchase:
                    await self.on_purchase(player, player.buy_now_price)
                
                # Автопродаж
                if self.config.auto_sell:
                    await self._auto_sell_player(player, target)
                
                return True
            else:
                self.stats.failed_purchases += 1
                
            await asyncio.sleep(self.config.buy_delay)
            
        return False
    
    async def _auto_sell_player(self, player: Player, target: SnipeTarget):
        """Автоматичний продаж купленої карти"""
        # Спочатку отримуємо непризначені карти
        unassigned = await self.client.get_unassigned()
        
        if not unassigned:
            return
            
        # Знаходимо нашу карту
        for item in unassigned:
            if item.get("resourceId") == player.resource_id:
                item_id = item["id"]
                
                # Переміщуємо в tradepile
                await self.client.send_to_tradepile(item_id)
                await asyncio.sleep(0.5)
                
                # Визначаємо ціну продажу
                if target.sell_price:
                    sell_price = target.sell_price
                else:
                    sell_price = int(player.buy_now_price * self.config.sell_markup)
                
                # EA має мінімальний крок ціни
                sell_price = self._round_price(sell_price)
                start_price = self._round_price(int(sell_price * 0.9))
                
                # Виставляємо на продаж
                trade_id = await self.client.list_item(
                    item_id=item_id,
                    start_price=start_price,
                    buy_now_price=sell_price,
                    duration=self.config.sell_duration
                )
                
                if trade_id:
                    logger.info(
                        f"📤 Виставлено на продаж: {player.name} "
                        f"за {sell_price:,} монет (очікуваний прибуток: {sell_price - player.buy_now_price:,})"
                    )
                break
    
    async def _relist_loop(self):
        """Цикл перевиставлення непроданих карт"""
        while not self._stop_event.is_set():
            try:
                if self.state != SniperState.RUNNING:
                    await asyncio.sleep(10)
                    continue
                
                # Очищаємо продані
                earned = await self.client.clear_sold()
                if earned > 0:
                    self.stats.total_earned += earned
                    self.stats.total_sales += 1
                    logger.info(f"💰 Продано! Зароблено: {earned:,} монет")
                    
                    if self.on_sale:
                        await self.on_sale(earned, self.stats.profit)
                
                # Перевиставляємо
                relisted = await self.client.relist_all()
                if relisted > 0:
                    logger.info(f"🔄 Перевиставлено {relisted} карт")
                    
                await asyncio.sleep(self.config.relist_interval)
                
            except Exception as e:
                logger.error(f"Relist error: {e}")
                await asyncio.sleep(30)
    
    async def _check_limits(self) -> bool:
        """Перевірка лімітів"""
        # Ліміт покупок
        if self.stats.total_purchases >= self.config.max_purchases:
            logger.info("Досягнуто ліміт покупок")
            return False
            
        # Ліміт пошуків на годину
        now = datetime.now()
        if (now - self._hour_start).seconds >= 3600:
            self._hour_start = now
            self._hourly_searches = 0
            
        if self._hourly_searches >= self.config.max_searches_per_hour:
            logger.warning("Ліміт пошуків на годину")
            return False
            
        # Перевірка tradepile
        tradepile = await self.client.get_tradepile()
        if len(tradepile) >= self.config.max_active_sales:
            logger.warning("Tradepile повний")
            return False
            
        return True
    
    @staticmethod
    def _round_price(price: int) -> int:
        """Округлення ціни до дозволеного кроку EA"""
        if price < 1000:
            return (price // 50) * 50
        elif price < 10000:
            return (price // 100) * 100
        elif price < 50000:
            return (price // 250) * 250
        elif price < 100000:
            return (price // 500) * 500
        else:
            return (price // 1000) * 1000
    
    def get_status(self) -> dict:
        """Отримати поточний статус"""
        return {
            "state": self.state.value,
            "stats": {
                "searches": self.stats.total_searches,
                "purchases": self.stats.total_purchases,
                "sales": self.stats.total_sales,
                "spent": self.stats.total_spent,
                "earned": self.stats.total_earned,
                "profit": self.stats.profit,
                "roi": f"{self.stats.roi:.1f}%"
            },
            "targets": [
                {
                    "name": t.name,
                    "enabled": t.enabled,
                    "max_price": t.max_buy_price,
                    "bought": t.bought
                }
                for t in self.targets
            ],
            "coins": self.client.coins
        }
