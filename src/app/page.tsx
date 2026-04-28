export default function Home() {
  return (
    <>
      <main className="app-shell">
            <section className="onboarding-panel" aria-label="We-trip onboarding">
              <div className="brand-row">
                <div className="brand-mark">We</div>
                <div>
                  <p className="eyebrow">We-trip AI</p>
                  <h1 data-i18n="hero">把一群人的偏好合成一条可执行路线</h1>
                </div>
              </div>

              <form id="trip-form" className="trip-form">
                <div className="field-grid">
                  <label>
                    <span data-i18n="destination">目的地国家</span>
                    <select id="country" name="country">
                      <option value="Japan">Japan</option>
                      <option value="England">England</option>
                      <option value="France">France</option>
                      <option value="Germany">Germany</option>
                      <option value="Spain">Spain</option>
                      <option value="Italy">Italy</option>
                      <option value="Norway">Norway</option>
                      <option value="Finland">Finland</option>
                      <option value="USA">USA</option>
                    </select>
                  </label>
                  <div className="city-selector-section">
                    <label>
                      <span data-i18n="city">目的地城市</span>
                    </label>
                    <div className="city-tags" id="city-tags"></div>
                    <div className="city-add-row">
                      <select id="city-add-select" className="city-add-select">
                      </select>
                      <button
                        type="button"
                        id="city-add-btn"
                        className="city-add-btn">
                        + 添加城市
                      </button>
                    </div>
                    <select id="destination" name="destination" hidden>
                    </select>
                  </div>
                  <label>
                    <span data-i18n="days">旅行天数</span>
                    <input id="days" name="days" type="number" min="2" max="10" defaultValue="5"  />
                  </label>
                  <label>
                    <span data-i18n="travelerCount">出行人数</span>
                    <input id="traveler-count" name="travelerCount" type="number" min="1" max="20" defaultValue="4" />
                  </label>
                  <label>
                    <span data-i18n="budgetMin">单人总行程预算下限</span>
                    <input id="budget-min" name="budgetMin" type="number" min="200" step="50" defaultValue="800"  />
                  </label>
                  <label>
                    <span data-i18n="budgetMax">单人总行程预算上限</span>
                    <input id="budget-max" name="budgetMax" type="number" min="300" step="50" defaultValue="1400"  />
                  </label>
                  <label>
                    <span data-i18n="discovery">发现模式</span>
                    <select id="discovery-mode" name="discoveryMode">
                      <option value="on">Keep the surprise ON</option>
                      <option value="off">Only nominated places</option>
                    </select>
                  </label>
                  <label>
                    <span data-i18n="transport">交通方式</span>
                    <select id="transport-mode" name="transportMode">
                      <option value="TRANSIT">Transit</option>
                      <option value="DRIVING">Driving</option>
                    </select>
                  </label>
                  <label>
                    <span data-i18n="hotelStars">酒店星级</span>
                    <select id="hotel-stars" name="hotelStars" defaultValue="3">
                      <option value="1">1★</option>
                      <option value="2">2★</option>
                      <option value="3">3★</option>
                      <option value="4">4★</option>
                      <option value="5">5★</option>
                    </select>
                  </label>
                  <div className="field-group">
                    <label>
                      <span data-i18n="departureAirport">出发机场</span>
                      <select id="departure-airport" name="departureAirport">
                        <option value="UNKNOWN">Unknown / 未定</option>
                        <option value="NRT">Tokyo Narita (NRT)</option>
                        <option value="HND">Tokyo Haneda (HND)</option>
                        <option value="LHR">London Heathrow (LHR)</option>
                        <option value="CDG">Paris CDG (CDG)</option>
                        <option value="TXL">Berlin Brandenburg (BER)</option>
                        <option value="FCO">Rome Fiumicino (FCO)</option>
                        <option value="BCN">Barcelona El Prat (BCN)</option>
                        <option value="OSL">Oslo Gardermoen (OSL)</option>
                        <option value="HEL">Helsinki Vantaa (HEL)</option>
                        <option value="JFK">New York JFK (JFK)</option>
                        <option value="LAX">Los Angeles (LAX)</option>
                        <option value="SFO">San Francisco (SFO)</option>
                      </select>
                    </label>
                    <label id="flight-time-label">
                      <span data-i18n="flightDepartureTime">航班起飞时间（最后一天）</span>
                      <input id="flight-dep-time" name="flightDepTime" type="time" defaultValue="14:00" />
                    </label>
                  </div>
                  <label>
                    <span data-i18n="nationality">主预订人国籍</span>
                    <select id="nationality" name="nationality">
                      <option value="CN">中国大陆</option>
                      <option value="SG">新加坡</option>
                      <option value="US">美国</option>
                      <option value="MY">马来西亚</option>
                    </select>
                  </label>
                  <label>
                    <span data-i18n="departure">出发日期</span>
                    <input id="departure" name="departure" type="date" required  />
                  </label>
                  <label>
                    <span data-i18n="language">语言</span>
                    <select id="language" name="language">
                      <option value="zh">中文</option>
                      <option value="en">English</option>
                    </select>
                  </label>
                </div>

                <div className="section-heading">
                  <span data-i18n="hotelAreas">每日酒店 / 住宿区域</span>
                  <button className="text-button" id="apply-hotel-all" type="button" data-i18n="applyAll">Apply all</button>
                </div>
                <div id="hotel-area-list" className="hotel-area-list" aria-label="Per-day hotel areas"></div>

                <div className="section-heading">
                  <span data-i18n="travelerPrefs">每位同行者的氛围和必去地点</span>
                  <span className="pill">3.5 invites / trip</span>
                </div>
                <div id="traveler-list" className="traveler-list" aria-label="Traveler preference inputs"></div>

                <div className="insight-strip" aria-label="Market validation">
                  <div>
                    <strong>70%+</strong>
                    <span data-i18n="insight1">跨国多人游用户手动协调数天</span>
                  </div>
                  <div>
                    <strong>8</strong>
                    <span data-i18n="insight2">竞品基准分析</span>
                  </div>
                  <div>
                    <strong>200</strong>
                    <span data-i18n="insight3">冷启动 4 周种子用户</span>
                  </div>
                </div>

                <button className="primary-button" type="submit">
                  <span data-i18n="generate">合成团队行程</span>
                  <span aria-hidden="true">→</span>
                </button>
              </form>
            </section>

            <section className="workspace-panel" aria-label="Generated itinerary workspace">
              <div className="workspace-header">
                <div>
                  <p className="eyebrow" data-i18n="workspaceEyebrow">多人行程优化</p>
                  <h2 id="workspace-title">等待生成行程</h2>
                </div>
                <div className="header-actions">
                  <button id="regenerate" className="icon-button" type="button" title="重新生成">↻</button>
                  <button id="share" className="secondary-button" type="button" data-i18n="share">邀请队友查看</button>
                </div>
              </div>

              <div id="alert-stack" className="alert-stack"></div>

              <div className="persona-band">
                <p className="label" data-i18n="personaLabel">团队画像合成</p>
                <p id="persona-copy">尚未生成画像。</p>
              </div>

              <div className="algorithm-band">
                <p className="label" data-i18n="algorithmLabel">路线生成算法</p>
                <div id="algorithm-copy" className="algorithm-grid"></div>
              </div>

              <div className="budget-module">
                <div className="budget-topline">
                  <span data-i18n="budgetMonitor">预算监控</span>
                  <strong id="budget-total">$0 / $0</strong>
                </div>
                <div className="budget-track">
                  <div id="budget-fill" className="budget-fill"></div>
                </div>
                <p id="budget-caption" className="muted">根据 Wishlist 地点预估门票、餐饮与市内交通。</p>
              </div>

              <div className="map-layout">
                <div className="map-column">
                  <div className="map-canvas">
                    <div className="map-toolbar">
                      <span id="route-summary">路径引擎</span>
                      <span data-i18n="modes">步行 / 公交 / 驾车</span>
                    </div>
                    <div
                      id="google-map"
                      style={{ width: "100%", height: "400px", borderRadius: "12px" }}
                    ></div>
                  </div>

                  <div id="reserve-pool-section" className="reserve-pool-section">
                    <div className="reserve-pool-header">
                      <h3 id="reserve-pool-title">备选地点池</h3>
                      <span id="reserve-pool-count" className="reserve-count"></span>
                    </div>
                    <div id="reserve-pool-list" className="reserve-pool-list"></div>
                  </div>
                </div>
                <aside className="itinerary-panel">
                  <div className="section-heading">
                    <span data-i18n="consensusRoute">共识路线</span>
                    <span id="place-count" className="pill">0 points</span>
                  </div>
                  <div id="itinerary-list" className="itinerary-list"></div>
                </aside>
              </div>
            </section>
          </main>

          <dialog id="detail-dialog" className="detail-dialog">
            <button id="close-dialog" className="icon-button close-button" type="button" title="关闭">×</button>
            <img id="detail-image" alt=""  />
            <div className="dialog-copy">
              <p id="detail-kicker" className="eyebrow"></p>
              <h3 id="detail-title"></h3>
              <p id="detail-body"></p>
            </div>
          </dialog>

          <div id="toast" className="toast" role="status" aria-live="polite"></div>
    </>
  );
}
