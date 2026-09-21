(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,52341,e=>{"use strict";var a=e.i(43476),l=e.i(71645),r=e.i(29309),s=e.i(89201),i=e.i(61413),n=e.i(30747);let t=[{id:"rest",label:"待機",when:"呼ばれるまで。ときどきよそ見をします"},{id:"listening",label:"聞いている",when:"触れられたとき、打ちこんでいるとき"},{id:"thinking",label:"考え中",when:"返事を考えている数百ミリ秒"},{id:"bright",label:"できた",when:"案内できたとき。笑いません（弾むだけ）"},{id:"oops",label:"分からない",when:"聞き取れなかったとき"},{id:"steady",label:"落ち着いて",when:"つらさが混じった言葉を受け取ったとき"}],o=[{name:"上の面",value:"var(--bl-pebble-lit)"},{name:"地の色",value:"var(--bl-pebble)"},{name:"下の面",value:"var(--bl-pebble-deep)"},{name:"影",value:"var(--bl-pebble-shade)"},{name:"花びら",value:"var(--bl-pebble-petal)"},{name:"目",value:"var(--bl-pebble-eye)"}];e.s(["default",0,function(){let e=(0,n.useReducedMotion)(),[c,d]=(0,l.useState)("rest"),[m,p]=(0,l.useState)(0),h=(0,l.useRef)(null),b=(0,l.useRef)(null),x=(0,l.useRef)(null),[u,f]=(0,l.useState)(!1);(0,l.useEffect)(()=>{if(!u)return;let a=h.current,l=b.current;if(!a||!l)return;let r=a.clientWidth-l.clientWidth,s={x:0,y:0},n={x:r,y:0};if(e){l.style.transform=`translate3d(${r}px, 0, 0)`;let e=window.setTimeout(()=>f(!1),0);return()=>window.clearTimeout(e)}let t=(0,i.glideMs)(s,n),o=(0,i.spinFor)(s,n),c=performance.now(),d=0,m=e=>{let a=Math.min((e-c)/t,1),s=(0,i.easeInOut)(a);if(l.style.transform=`translate3d(${r*s}px, 0, 0)`,x.current&&(x.current.style.transform=`rotate(${o*s}deg)`),a<1){d=requestAnimationFrame(m);return}window.setTimeout(()=>{let e=performance.now(),a=s=>{let n=Math.min((s-e)/t,1),c=(0,i.easeInOut)(n);l.style.transform=`translate3d(${r*(1-c)}px, 0, 0)`,x.current&&(x.current.style.transform=`rotate(${-o*c+o}deg)`),n<1?d=requestAnimationFrame(a):(x.current&&(x.current.style.transform=""),f(!1))};d=requestAnimationFrame(a)},420)};return d=requestAnimationFrame(m),()=>cancelAnimationFrame(d)},[u,e]);let g=s.EXPRESSIONS[c];return(0,a.jsxs)("main",{className:"meet",children:[(0,a.jsxs)("header",{className:"hero",children:[(0,a.jsx)("div",{className:"heroPebble",children:(0,a.jsx)(r.Pebble,{expression:c,size:210,hopKey:m})}),(0,a.jsxs)("div",{children:[(0,a.jsx)("p",{className:"kicker",children:"blesc の案内役"}),(0,a.jsx)("h1",{className:"title",children:"はじめまして、ラスクくんです"}),(0,a.jsx)("p",{className:"lede",children:"画面の隅にいて、行きたいページへ連れていったり、画面に出ている言葉の意味を、 その場所まで行って説明したりします。相談ごとは引き受けません — それは「相談」の ページが、同意と記録の仕組みごと引き受けている仕事だからです。"}),(0,a.jsxs)("div",{className:"actions",children:[(0,a.jsx)("button",{type:"button",className:"bl-btn bl-btn--primary",onClick:()=>p(e=>e+1),children:"つついてみる"}),(0,a.jsx)("button",{type:"button",className:"bl-btn bl-btn--secondary",onClick:()=>f(!0),disabled:u,children:"転がってみる"})]})]})]}),(0,a.jsxs)("section",{className:"panelCard",children:[(0,a.jsx)("h2",{className:"h2",children:"名前のこと"}),(0,a.jsxs)("p",{className:"body",children:["b",(0,a.jsx)("b",{children:"l"}),"esc の ",(0,a.jsx)("b",{children:"l"})," と、",(0,a.jsx)("b",{children:"ask"}),"（聞く）から。呼ぶときは「ラスクくん」、 自分で名乗るときは「ラスクです」— 自分に「くん」は付けません。"]}),(0,a.jsx)("p",{className:"mono",children:"b·l·esc ＋ a·s·k → ラスク"})]}),(0,a.jsx)("section",{className:"track",ref:h,children:(0,a.jsx)("div",{className:"runner",ref:b,children:(0,a.jsx)(r.Pebble,{ref:x,expression:u?"listening":"rest",size:72})})}),(0,a.jsxs)("section",{className:"panelCard",children:[(0,a.jsx)("h2",{className:"h2",children:"顔は6つ"}),(0,a.jsx)("p",{className:"body",children:"絵を描き替えているのではありません。輪郭も目も12個の数字で決まっていて、その数字を ばねで引っぱっています。だから途中の姿が全部あって、切り替わる瞬間が見えません。"}),(0,a.jsx)("ul",{className:"faces",children:t.map(e=>(0,a.jsx)("li",{children:(0,a.jsxs)("button",{type:"button",className:"faceBtn","data-active":c===e.id?"":void 0,onClick:()=>{d(e.id),p(e=>e+1)},children:[(0,a.jsx)(r.Pebble,{expression:e.id,size:64}),(0,a.jsx)("span",{className:"faceName",children:e.label}),(0,a.jsx)("span",{className:"faceWhen",children:e.when})]})},e.id))}),(0,a.jsxs)("p",{className:"mono",children:["いまの数字： rx ",g.rx," / ry ",g.ry," / 傾き ",g.lean,"° / 目の幅 ",g.eyeRx," / 目の間隔 ",g.eyeGap]})]}),(0,a.jsxs)("section",{className:"panelCard",children:[(0,a.jsx)("h2",{className:"h2",children:"色"}),(0,a.jsx)("p",{className:"body",children:"画面の青（ボタンや入力欄）より明るく、少しだけ緑へ振ってあります。同じ色相のまま 明るくすると、どれだけ陰影を付けてもボタンの仲間に見えてしまうためです。"}),(0,a.jsx)("ul",{className:"swatches",children:o.map(e=>(0,a.jsxs)("li",{children:[(0,a.jsx)("span",{className:"chip",style:{background:e.value}}),e.name]},e.name))})]}),(0,a.jsxs)("section",{className:"panelCard",children:[(0,a.jsx)("h2",{className:"h2",children:"しないこと"}),(0,a.jsxs)("ul",{className:"dont",children:[(0,a.jsx)("li",{children:"笑いません。指しながらにこにこしていると、説明ではなく愛嬌になるので。"}),(0,a.jsx)("li",{children:"口はありません。顔で気分を採点しているように見せないためです。"}),(0,a.jsx)("li",{children:"つらさが混じった言葉には、跳ねも回りもしません。落ち着いた顔で、すぐに返します。"}),(0,a.jsx)("li",{children:"ここで打った言葉は、端末の外に出ません。"})]})]}),(0,a.jsxs)("footer",{className:"foot",children:[(0,a.jsx)("a",{className:"bl-btn bl-btn--ghost",href:"/demo-view",children:"デモ表示へ"}),(0,a.jsx)("p",{className:"micro",children:"チームで見るための一時的なページです。固定データ・API なし。"})]}),(0,a.jsx)("style",{children:`
        .meet {
          max-width: 860px;
          margin: 0 auto;
          padding: 40px 20px 72px;
          display: flex;
          flex-direction: column;
          gap: 22px;
        }
        .hero { display: flex; gap: 28px; align-items: center; flex-wrap: wrap; }
        .heroPebble { flex: none; }
        .kicker { margin: 0 0 4px; font-size: 0.78rem; letter-spacing: 0.08em; color: var(--bl-ink-3); }
        .title { margin: 0 0 10px; font-size: 1.7rem; line-height: 1.35; color: var(--bl-ink); }
        .lede { margin: 0 0 16px; font-size: 0.95rem; line-height: 1.85; color: var(--bl-ink-2); max-width: 46ch; }
        .actions { display: flex; gap: 10px; flex-wrap: wrap; }

        .panelCard {
          background: var(--bl-surface);
          border: 1px solid var(--bl-line);
          border-radius: var(--bl-radius);
          padding: 20px 22px;
        }
        .h2 { margin: 0 0 8px; font-size: 1.05rem; color: var(--bl-ink); }
        .body { margin: 0 0 12px; font-size: 0.92rem; line-height: 1.85; color: var(--bl-ink-2); }
        .mono {
          margin: 10px 0 0; font-size: 0.78rem; color: var(--bl-ink-3);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }

        .track {
          position: relative;
          height: 96px;
          border-radius: var(--bl-radius);
          background: linear-gradient(var(--bl-mist), var(--bl-surface));
          border: 1px solid var(--bl-line-soft);
          overflow: hidden;
        }
        .runner { position: absolute; left: 10px; bottom: 10px; width: 72px; height: 72px; }

        .faces { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
        .faceBtn {
          width: 100%; display: grid; grid-template-columns: 64px 1fr; grid-template-rows: auto auto;
          gap: 2px 12px; align-items: center; text-align: left;
          padding: 10px; border-radius: var(--bl-radius-inner); border: 1px solid var(--bl-line-soft);
          background: var(--bl-surface); cursor: pointer;
        }
        .faceBtn:hover { border-color: var(--bl-blue); background: var(--bl-mist); }
        .faceBtn[data-active] { border-color: var(--bl-blue-strong); background: var(--bl-mist); }
        .faceBtn svg { grid-row: span 2; }
        .faceName { font-size: 0.88rem; color: var(--bl-ink); align-self: end; }
        .faceWhen { font-size: 0.74rem; line-height: 1.5; color: var(--bl-ink-3); align-self: start; }

        .swatches { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 14px; font-size: 0.8rem; color: var(--bl-ink-2); }
        .swatches li { display: flex; align-items: center; gap: 7px; }
        .chip { width: 22px; height: 22px; border-radius: 7px; border: 1px solid hsl(var(--bl-hue) 30% 80% / 0.6); }

        .dont { margin: 0; padding-left: 1.1em; font-size: 0.9rem; line-height: 1.9; color: var(--bl-ink-2); }

        .foot { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
        .micro { margin: 0; font-size: 0.74rem; color: var(--bl-ink-3); }

        @media (max-width: 640px) {
          .title { font-size: 1.4rem; }
          .heroPebble svg { width: 150px; height: 150px; }
        }
      `})]})}])}]);