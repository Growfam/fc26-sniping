"""
EA FC 26 Web App Client
Працює через cookies як справжній браузер
"""

import asyncio
import httpx
import json
import random
import time
from typing import Optional, Dict, List, Any
from dataclasses import dataclass
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


@dataclass
class Player:
    """Карта гравця"""
    trade_id: int
    asset_id: int
    resource_id: int
    name: str
    rating: int
    position: str
    buy_now_price: int
    current_bid: int
    expires: int
    seller_established: bool
    
    @property
    def is_snipeable(self) -> bool:
        """Чи можна снайпнути (мало часу до кінця)"""
        return self.expires < 3600  # менше години


@dataclass  
class SearchFilter:
    """Фільтр пошуку"""
    player_id: Optional[int] = None
    min_price: Optional[int] = None
    max_price: Optional[int] = None
    min_buy: Optional[int] = None
    max_buy: Optional[int] = None
    quality: Optional[str] = None  # bronze, silver, gold, special
    position: Optional[str] = None
    nation: Optional[int] = None
    league: Optional[int] = None
    club: Optional[int] = None
    rarity_id: Optional[int] = None


class EAClient:
    """
    Клієнт для EA FC Web App
    Емулює браузерні запити через cookies
    """
    
    BASE_URL = "https://utas.mob.v1.fut.ea.com/ut/game/fc26"
    AUTH_URL = "https://accounts.ea.com"
    
    # Заголовки як у справжньому браузері
    DEFAULT_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Content-Type": "application/json",
        "Origin": "https://www.ea.com",
        "Referer": "https://www.ea.com/",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
    }
    
    def __init__(self, cookies: Dict[str, str], sid: str, platform: str = "pc"):
        """
        Args:
            cookies: Cookies з браузера (після логіну в Web App)
            sid: Session ID (X-UT-SID заголовок)
            platform: pc, ps5, xbox
        """
        self.cookies = cookies
        self.sid = sid
        self.platform = platform
        
        self.client = httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=True
        )
        
        # Статистика
        self.requests_count = 0
        self.purchases_count = 0
        self.coins = 0
        self.last_request_time = 0
        
        # Rate limiting
        self.min_request_interval = 1.0  # мінімум 1 секунда між запитами
        
    def _get_headers(self) -> Dict[str, str]:
        """Отримати заголовки з актуальним SID"""
        headers = self.DEFAULT_HEADERS.copy()
        headers["X-UT-SID"] = self.sid
        return headers
    
    async def _request(
        self, 
        method: str, 
        endpoint: str, 
        data: Optional[Dict] = None,
        params: Optional[Dict] = None
    ) -> Dict:
        """
        Виконати запит до EA API
        """
        # Rate limiting
        now = time.time()
        elapsed = now - self.last_request_time
        if elapsed < self.min_request_interval:
            await asyncio.sleep(self.min_request_interval - elapsed + random.uniform(0.1, 0.5))
        
        url = f"{self.BASE_URL}{endpoint}"
        
        try:
            response = await self.client.request(
                method=method,
                url=url,
                headers=self._get_headers(),
                cookies=self.cookies,
                json=data,
                params=params
            )
            
            self.last_request_time = time.time()
            self.requests_count += 1
            
            if response.status_code == 200:
                return response.json()
            elif response.status_code == 401:
                raise AuthError("Session expired. Need to re-login.")
            elif response.status_code == 426:
                raise CaptchaError("Captcha required!")
            elif response.status_code == 429:
                raise RateLimitError("Too many requests!")
            elif response.status_code == 458:
                raise TransferBanError("Transfer market banned!")
            else:
                logger.error(f"Request failed: {response.status_code} - {response.text}")
                raise EAError(f"Request failed: {response.status_code}")
                
        except httpx.RequestError as e:
            logger.error(f"Network error: {e}")
            raise NetworkError(str(e))
    
    # ==========================================
    # ОСНОВНІ МЕТОДИ
    # ==========================================
    
    async def get_credits(self) -> int:
        """Отримати баланс монет"""
        response = await self._request("GET", "/user/credits")
        self.coins = response.get("credits", 0)
        return self.coins
    
    async def get_tradepile(self) -> List[Dict]:
        """Отримати список карт на продажу"""
        response = await self._request("GET", "/tradepile")
        return response.get("auctionInfo", [])
    
    async def get_watchlist(self) -> List[Dict]:
        """Отримати список відстежуваних"""
        response = await self._request("GET", "/watchlist")
        return response.get("auctionInfo", [])
    
    async def get_unassigned(self) -> List[Dict]:
        """Отримати непризначені карти"""
        response = await self._request("GET", "/purchased/items")
        return response.get("itemData", [])
    
    async def search(self, filter: SearchFilter, page: int = 0) -> List[Player]:
        """
        Пошук на трансферному ринку
        
        Returns:
            Список знайдених карт
        """
        params = {
            "num": 21,  # Максимум результатів
            "start": page * 21,
            "type": "player"
        }
        
        # Додаємо фільтри
        if filter.player_id:
            params["maskedDefId"] = filter.player_id
        if filter.min_price:
            params["minb"] = filter.min_price
        if filter.max_price:
            params["maxb"] = filter.max_price
        if filter.min_buy:
            params["minb"] = filter.min_buy
        if filter.max_buy:
            params["maxb"] = filter.max_buy
        if filter.quality:
            params["lev"] = filter.quality
        if filter.position:
            params["pos"] = filter.position
        if filter.nation:
            params["nat"] = filter.nation
        if filter.league:
            params["leag"] = filter.league
        if filter.club:
            params["team"] = filter.club
        if filter.rarity_id:
            params["rarityIds"] = filter.rarity_id
            
        response = await self._request("GET", "/transfermarket", params=params)
        
        players = []
        for item in response.get("auctionInfo", []):
            try:
                item_data = item.get("itemData", {})
                players.append(Player(
                    trade_id=item["tradeId"],
                    asset_id=item_data.get("assetId", 0),
                    resource_id=item_data.get("resourceId", 0),
                    name=item_data.get("lastName", "Unknown"),
                    rating=item_data.get("rating", 0),
                    position=item_data.get("preferredPosition", ""),
                    buy_now_price=item.get("buyNowPrice", 0),
                    current_bid=item.get("currentBid", 0),
                    expires=item.get("expires", 0),
                    seller_established=item.get("sellerEstablished", False)
                ))
            except Exception as e:
                logger.warning(f"Failed to parse player: {e}")
                
        return players
    
    async def buy_now(self, trade_id: int, price: int) -> bool:
        """
        Купити карту за BIN (Buy It Now)
        
        Returns:
            True якщо успішно куплено
        """
        data = {
            "bid": price
        }
        
        try:
            response = await self._request("PUT", f"/trade/{trade_id}/bid", data=data)
            
            if response.get("auctionInfo"):
                self.purchases_count += 1
                logger.info(f"✅ Куплено trade_id={trade_id} за {price} монет!")
                return True
            return False
            
        except Exception as e:
            logger.error(f"Buy failed: {e}")
            return False
    
    async def bid(self, trade_id: int, bid_amount: int) -> bool:
        """Поставити ставку на аукціон"""
        data = {"bid": bid_amount}
        
        try:
            response = await self._request("PUT", f"/trade/{trade_id}/bid", data=data)
            return bool(response.get("auctionInfo"))
        except:
            return False
    
    async def list_item(
        self, 
        item_id: int, 
        start_price: int, 
        buy_now_price: int, 
        duration: int = 3600
    ) -> Optional[int]:
        """
        Виставити карту на продаж
        
        Args:
            item_id: ID предмета
            start_price: Початкова ціна
            buy_now_price: BIN ціна
            duration: Тривалість (3600 = 1 год, 10800 = 3 год, 21600 = 6 год, 43200 = 12 год, 86400 = 24 год, 259200 = 3 дні)
            
        Returns:
            trade_id якщо успішно
        """
        data = {
            "itemData": {
                "id": item_id
            },
            "startingBid": start_price,
            "duration": duration,
            "buyNowPrice": buy_now_price
        }
        
        try:
            response = await self._request("POST", "/auctionhouse", data=data)
            return response.get("id")
        except Exception as e:
            logger.error(f"List failed: {e}")
            return None
    
    async def send_to_tradepile(self, item_id: int) -> bool:
        """Відправити карту в tradepile"""
        data = {"itemData": [{"id": item_id, "pile": "trade"}]}
        
        try:
            response = await self._request("PUT", "/item", data=data)
            return bool(response.get("itemData"))
        except:
            return False
    
    async def send_to_club(self, item_id: int) -> bool:
        """Відправити карту в клуб"""
        data = {"itemData": [{"id": item_id, "pile": "club"}]}
        
        try:
            response = await self._request("PUT", "/item", data=data)
            return bool(response.get("itemData"))
        except:
            return False
    
    async def quick_sell(self, item_id: int) -> int:
        """Швидкий продаж за дисконт"""
        try:
            response = await self._request("DELETE", f"/item/{item_id}")
            return response.get("coins", 0)
        except:
            return 0
    
    async def relist_all(self) -> int:
        """Перевиставити всі прострочені лоти"""
        try:
            response = await self._request("PUT", "/auctionhouse/relist")
            return len(response.get("tradeIdList", []))
        except:
            return 0
    
    async def clear_sold(self) -> int:
        """Очистити продані предмети"""
        try:
            response = await self._request("DELETE", "/trade/sold")
            # Рахуємо зароблені монети
            return response.get("coins", 0)
        except:
            return 0
    
    async def keepalive(self) -> bool:
        """Підтримка сесії активною"""
        try:
            await self.get_credits()
            return True
        except:
            return False
    
    async def close(self):
        """Закрити клієнт"""
        await self.client.aclose()


# ==========================================
# КАСТОМНІ ПОМИЛКИ
# ==========================================

class EAError(Exception):
    """Базова помилка EA"""
    pass

class AuthError(EAError):
    """Помилка авторизації"""
    pass

class CaptchaError(EAError):
    """Потрібна капча"""
    pass

class RateLimitError(EAError):
    """Занадто багато запитів"""
    pass

class TransferBanError(EAError):
    """Бан трансферного ринку"""
    pass

class NetworkError(EAError):
    """Помилка мережі"""
    pass
