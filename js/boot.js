(() => {
  let saved=null;
  try { saved=localStorage.getItem("tutorhub_color_mode_v1"); } catch {}
  document.documentElement.dataset.colorMode=saved==="dark"?"dark":"light";
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
