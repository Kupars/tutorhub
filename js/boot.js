(() => {
      const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
      let saved = null;
      try { saved = localStorage.getItem("tutorhub_color_mode_v1"); } catch { /* 隐私模式 */ }
      document.documentElement.dataset.colorMode = saved === "light" || saved === "dark"
        ? saved : (systemDark ? "dark" : "light");
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai",
        year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
      const number = (type) => Number(parts.find((part) => part.type === type).value);
      const y = number("year") % 100;
      const md = number("month") * 100 + number("day");
      const termDay = (c) => Math.floor(y * 0.2422 + c) - Math.floor((y - 1) / 4);
      document.documentElement.dataset.season = md < 200 + termDay(3.87) ? "winter"
        : md < 500 + termDay(5.52) ? "spring"
        : md < 800 + termDay(7.5) ? "summer"
        : md < 1100 + termDay(7.438) ? "autumn" : "winter";
    })();

// 即使部分脚本在微信浏览器内加载失败，也不要让全屏动画永远没有反馈。
    setTimeout(() => {
      const overlay = document.getElementById("startupLoading");
      if (!overlay || overlay.hidden) return;
      document.getElementById("startupLoadingDetail").textContent = "网络加载较慢，可尝试切换 Wi-Fi / 移动网络后重新打开。";
      const retry = document.getElementById("startupRetry");
      retry.hidden = false;
      retry.onclick = () => location.reload();
    }, 13000);
