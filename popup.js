const init = () => {
  const btn = document.getElementById('add-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: parseTravelBookingData
      });

      if (results && results[0].result) {
        const data = results[0].result;
        const sanitizeForCalendar = (s, maxLen = 200) => {
          if (!s) return "";
          const cleaned = String(s)
            .replace(/[\u0000-\u001F\u007F]/g, '')
            .replace(/[\uE000-\uF8FF]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
        };
        const baseUrl = "https://www.google.com/calendar/render?action=TEMPLATE";
        
        const formatTimePart = (t) => {
          if (!t) return "000000";
          const m = t.match(/(\d{1,2}):(\d{2})/);
          return m ? `${m[1].padStart(2, '0')}${m[2]}00` : "000000";
        };

        const tStart = formatTimePart(data.startTime);
        let tEnd = formatTimePart(data.endTime);
        if (data.category === "空港送迎") {
          tEnd = tStart;
        } else if (tEnd === "000000" && tStart !== "000000") {
          const hh = parseInt(tStart.slice(0, 2), 10);
          const mm = tStart.slice(2, 4);
          const endH = String((hh + 1) % 24).padStart(2, '0');
          tEnd = `${endH}${mm}00`;
        }
        
        // 航空券などで終了日が開始日と異なる場合にも対応
        const dates = `${data.startDate}T${tStart}/${data.endDate}T${tEnd}`;

        const safeCategory = sanitizeForCalendar(data.category, 20);
        const safeTitle = sanitizeForCalendar(data.title, 80);
        const safeLocation = sanitizeForCalendar(data.location, 120);
        const safeSummary = sanitizeForCalendar(data.summary, 300);
        const safeBookingId = sanitizeForCalendar(data.bookingId, 30);

        const detailsLines = [];
        if (safeBookingId) detailsLines.push(`予約番号: ${safeBookingId}`);
        if (safeSummary && !safeSummary.includes(safeBookingId)) detailsLines.push(`内容: ${safeSummary}`);
        detailsLines.push("※自動抽出データ");

        const params = new URLSearchParams({
          text: `【${safeCategory}】${safeTitle}`,
          dates: dates,
          details: detailsLines.join('\n'),
          location: safeLocation
        });

        window.open(`${baseUrl}&${params.toString()}`, '_blank');
      }
    } catch (error) {
      console.error(error);
      alert('エラーが発生しました。ページを更新して再度お試しください。');
    }
  });
};

// DOMの読み込み完了を確認してから実行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function parseTravelBookingData() {
  const host = window.location.hostname;
  let res = { title: "", category: "予約", startDate: "", endDate: "", startTime: "", endTime: "", location: "", bookingId: "", summary: "" };

  const textOf = (el) => (el && el.textContent ? el.textContent.trim() : "");
  const findYear = () => {
    const m = document.body && document.body.textContent
      ? document.body.textContent.match(/(20\d{2})年/)
      : null;
    return m ? m[1] : String(new Date().getFullYear());
  };
  const parseMonthDay = (s) => {
    if (!s) return null;
    const m = s.match(/(\d{1,2})月(\d{1,2})日/);
    if (!m) return null;
    return { month: m[1].padStart(2, '0'), day: m[2].padStart(2, '0') };
  };

  // --- Trip.com解析 (内部データ __NEXT_DATA__ を利用 / フォールバックはDOM) ---
  if (host.includes('trip.com')) {
    const nextData = document.getElementById('__NEXT_DATA__');
    if (nextData) {
      try {
        const json = JSON.parse(nextData.innerText);
        const data = json?.props?.pageProps?.response;
        const common = data?.orderCommonInfo;

        // 航空券予約の場合
        if (data?.flightInfo?.flights) {
          const f = data.flightInfo.flights[0];
          res.category = "航空券";
          res.title = `${f.flightNo} (${f.departureCityName} → ${f.arrivalCityName})`;
          res.startDate = f.departureDate.replace(/-/g, '');
          res.endDate = f.arrivalDate.replace(/-/g, '');
          res.startTime = f.departureTime;
          res.endTime = f.arrivalTime;
          res.location = `${f.departureAirportName} (${f.departureAirportCode})`;
          res.bookingId = common?.orderId?.toString() || "";
          res.summary = `便名: ${f.flightNo}\n区間: ${f.departureCityName} → ${f.arrivalCityName}`;
          return res;
        }
        // ホテル予約の場合
        if (common?.hotelName) {
          res.category = "宿泊";
          res.title = common.hotelName;
          res.startDate = common.checkInDate;
          res.endDate = common.checkOutDate;
          res.startTime = data?.stayInfo?.checkInInfo?.time || "";
          res.endTime = data?.stayInfo?.checkOutInfo?.time || "";
          res.location = data?.hotelInfo?.hotelAddress || "";
          res.bookingId = common?.orderId?.toString() || "";
          res.summary = data?.roomInfo?.roomName || "";
          return res;
        }
      } catch (e) {
        // fall through to DOM parsing
      }
    }

    // --- Trip.com DOMフォールバック (保存したHTMLにも対応) ---
    const orderIdText = textOf(document.querySelector('[data-testid="orderstatus_OrderId"]'));
    const orderIdMatch = orderIdText.match(/予約番号[:：]\s*(\d+)/);
    res.bookingId = orderIdMatch ? orderIdMatch[1] : "";

    const dateText = textOf(document.querySelector('[data-testid="tripItem_TimeText"]'));
    const md = parseMonthDay(dateText);
    if (md) {
      const y = findYear();
      res.startDate = `${y}${md.month}${md.day}`;
      res.endDate = res.startDate;
    }

    const timeEls = Array.from(document.querySelectorAll('strong[data-testid^="tripItem_TripTime"]'));
    const times = timeEls.map((el) => textOf(el)).filter(Boolean);
    res.startTime = times[0] || "";
    res.endTime = times[1] || "";

    const cityEls = Array.from(document.querySelectorAll('[data-testid="tripItem_CName"]'))
      .map((el) => textOf(el))
      .filter((t) => t && !/^[\-–－]$/.test(t));
    const departureCity = cityEls[0] || "";
    const arrivalCity = cityEls.length ? cityEls[cityEls.length - 1] : "";

    const ptag = document.querySelector('[data-testid^="tripItem_PTagBox"]');
    const ptext = textOf(ptag);
    const flightNoMatch = ptext.match(/\b[A-Z0-9]{2,3}\s?\d{2,4}\b/);
    const flightNo = flightNoMatch ? flightNoMatch[0].replace(/\s/g, '') : "";

    const tripCities = document.querySelectorAll('[data-testid="tripItem_TripCity"]');
    const firstTripCity = tripCities[0] || null;
    const airportCode = firstTripCity ? textOf(firstTripCity.querySelector('[data-testid^="tripItem_span"]')) : "";
    const airportName = firstTripCity ? textOf(firstTripCity.querySelector('[data-testid^="tripItem_SpanBox"]')) : "";

    if (departureCity || arrivalCity || flightNo) {
      res.category = "航空券";
      res.title = flightNo && departureCity && arrivalCity
        ? `${flightNo} (${departureCity} → ${arrivalCity})`
        : (flightNo || [departureCity, arrivalCity].filter(Boolean).join(' → '));
      res.location = airportName ? (airportCode ? `${airportName} (${airportCode})` : airportName) : departureCity;
      res.summary = [
        flightNo ? `便名: ${flightNo}` : "",
        (departureCity || arrivalCity) ? `区間: ${departureCity} → ${arrivalCity}` : ""
      ].filter(Boolean).join('\n');
      return res;
    }

    // --- Trip.com 空港送迎/レンタカー系 (本文テキストから抽出) ---
    const sanitizeText = (s, maxLen = 200) => {
      if (!s) return "";
      const cleaned = s
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/[\uE000-\uF8FF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
    };
    const bodyText = sanitizeText(document.body && document.body.textContent ? document.body.textContent : "", 5000);
    if (bodyText.includes('空港送迎') || bodyText.includes('空港行片道送迎') || bodyText.includes('空港発片道送迎')) {
      const orderIdMatch = bodyText.match(/予約番号\s*(\d{6,})/);
      res.bookingId = orderIdMatch ? orderIdMatch[1] : res.bookingId;

      const dtTypeMatch = bodyText.match(/(20\d{2}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2})\s*·\s*([^\n]*送迎)/);
      const dtMatch = bodyText.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:\d{2})/);
      if (dtTypeMatch || dtMatch) {
        const dt = (dtTypeMatch ? dtTypeMatch[1] : dtMatch[0]);
        const m = dt.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:\d{2})/);
        if (m) {
          res.startDate = `${m[1]}${m[2].padStart(2, '0')}${m[3].padStart(2, '0')}`;
          res.endDate = res.startDate;
          res.startTime = m[4];
        }
      }

      let transferType = "空港送迎";
      if (dtTypeMatch && dtTypeMatch[2]) {
        const typeMatch = dtTypeMatch[2].match(/(空港[^\s·]*送迎|空港送迎)/);
        transferType = sanitizeText(typeMatch ? typeMatch[1] : "空港送迎", 20);
      }

      let route = "";
      const routeMatch = bodyText.match(/推定所要時間[^）]*\)\s*(.+?)(無料待機時間|キャンセル無料|規約|連絡先|電話番号|メール|$)/);
      if (routeMatch) {
        route = sanitizeText(
          routeMatch[1]
            .replace(/航空便\s*[A-Z0-9]+\b/, '')
            .replace(/通常/g, '')
            .replace(/下記は全て現地時間です/g, '')
            .replace(/推定所要時間[^）]*\)/g, '')
        , 160);
      }

      res.category = "空港送迎";
      res.title = transferType;
      const routeLooksValid = route && (route.includes('空港') || route.includes('ホテル') || /[A-Za-z]/.test(route) || /\d/.test(route));
      res.location = routeLooksValid ? route : res.location;
      res.summary = [
        route ? `区間: ${route}` : "",
        res.bookingId ? `予約番号: ${res.bookingId}` : ""
      ].filter(Boolean).join('\n');
      return res;
    }
  }

  // --- Booking.com解析 (DOMテキスト/HTMLから抽出) ---
  if (host.includes('booking.com')) {
    const bodyText = document.body && (document.body.innerText || document.body.textContent)
      ? (document.body.innerText || document.body.textContent)
      : "";
    const clean = bodyText.replace(/\s+/g, ' ').trim();
    const html = document.documentElement ? document.documentElement.innerHTML : "";

    let hotelName = "";
    let m = html.match(/hotel_name\s*[:=]\s*'([^']+)'/);
    if (m) hotelName = m[1];
    if (!hotelName) {
      m = html.match(/\"hotel_name\"\\s*:\\s*\"([^\"]+)\"/);
      if (m) hotelName = m[1];
    }
    if (!hotelName) {
      const idx = clean.indexOf('チェックイン');
      if (idx > 0) {
        const prefix = clean.slice(Math.max(0, idx - 120), idx).trim();
        hotelName = prefix.split(' ').slice(-12).join(' ');
      }
    }

    const checkinMatch = clean.match(/チェックイン\s*(\d{4})年(\d{1,2})月(\d{1,2})日(?:\\([^\\)]*\\))?\\s*(\d{1,2}:\d{2})?/);
    const checkoutMatch = clean.match(/チェックアウト\s*(\d{4})年(\d{1,2})月(\d{1,2})日(?:\\([^\\)]*\\))?\\s*(\d{1,2}:\d{2})?/);
    if (checkinMatch) {
      res.startDate = `${checkinMatch[1]}${checkinMatch[2].padStart(2, '0')}${checkinMatch[3].padStart(2, '0')}`;
      res.startTime = checkinMatch[4] || "";
    }
    if (checkoutMatch) {
      res.endDate = `${checkoutMatch[1]}${checkoutMatch[2].padStart(2, '0')}${checkoutMatch[3].padStart(2, '0')}`;
      res.endTime = checkoutMatch[4] || "";
    } else if (res.startDate) {
      res.endDate = res.startDate;
    }

    const addrMatch = clean.match(/住所\s*([\s\S]*?)(道順を表示する|予約番号|暗証番号|予約内容|キャンセル|$)/);
    const address = addrMatch ? addrMatch[1].trim() : "";

    const bookingMatch = clean.match(/予約番号[:：]\s*(\d+)/);
    const bookingId = bookingMatch ? bookingMatch[1] : "";

    if (hotelName || address || bookingId || res.startDate) {
      res.category = "宿泊";
      res.title = hotelName || "宿泊";
      res.location = address || "";
      res.bookingId = bookingId;
      const summaryParts = [];
      if (address) summaryParts.push(`住所: ${address}`);
      if (checkinMatch) summaryParts.push(`チェックイン: ${checkinMatch[1]}年${checkinMatch[2]}月${checkinMatch[3]}日${checkinMatch[4] ? ` ${checkinMatch[4]}` : ""}`);
      if (checkoutMatch) summaryParts.push(`チェックアウト: ${checkoutMatch[1]}年${checkoutMatch[2]}月${checkoutMatch[3]}日${checkoutMatch[4] ? ` ${checkoutMatch[4]}` : ""}`);
      res.summary = summaryParts.join('\n');
      return res;
    }
  }

  // --- Booking.com & その他 (構造化データを解析) ---
  const ldJsonScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (let script of ldJsonScripts) {
    try {
      const data = JSON.parse(script.innerText);
      const items = Array.isArray(data) ? data : [data];
      const reserve = items.find(d => d['@type']?.includes('Reservation'));
      if (reserve) {
        const item = reserve.reservationFor || reserve;
        res.title = item.name || document.title;
        res.category = reserve['@type'].includes('Lodging') ? "宿泊" : "予約";
        res.bookingId = reserve.reservationId || "";
        res.startDate = (reserve.checkinDate || reserve.startDate || "").replace(/-/g, '').slice(0,8);
        res.endDate = (reserve.checkoutDate || reserve.endDate || "").replace(/-/g, '').slice(0,8);
        res.location = item.address?.streetAddress || item.location?.name || "";
        return res;
      }
    } catch (e) { continue; }
  }
  return res;
}
