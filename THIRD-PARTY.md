# 内嵌的第三方前端依赖

本项目把前端依赖**本地内嵌**（而不是引用 CDN），以保证：

- 页面在公网、工厂内网、甚至完全断网的车间里都能打开；
- 不受第三方 CDN 可用性与版本漂移影响；
- 交付就是一个静态目录，没有构建、没有 npm install。

| 文件 | 组件 | 版本 | 授权 | 来源 |
|---|---|---|---|---|
| `vue.global.prod.js` | Vue 3（运行时 + 模板编译器） | 3.5.13 | MIT | <https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js> |
| `element-plus.full.min.js` | Element Plus（UMD 全量） | 2.9.1 | MIT | <https://unpkg.com/element-plus@2.9.1/dist/index.full.min.js> |
| `element-plus.css` | Element Plus 样式 | 2.9.1 | MIT | <https://unpkg.com/element-plus@2.9.1/dist/index.css> |
| `element-plus-icons.iife.min.js` | Element Plus Icons | 2.3.1 | MIT | <https://unpkg.com/@element-plus/icons-vue@2.3.1/dist/index.iife.min.js> |

四者均为 MIT 授权，允许自由使用与再分发，需保留其原始授权声明。
Element Plus 与 Vue 的版权归其各自作者与贡献者所有，本项目仅作为依赖内嵌使用，未做修改。

更新方式：重新下载对应版本覆盖同名文件，并同步本文件的版本号。

## 除此之外没有任何依赖

- 没有构建工具、没有打包器、没有 npm 依赖（`package.json` 里没有 `dependencies`）；
- 图表是手写的 SVG + CSS，没有引入图表库；
- 导出只有 CSV / JSON / Markdown，没有引入 PDF、Excel 之类的大型库；
- 运行时不发任何外部请求。唯一的例外是「数据与设置」里那个**默认关闭**的自备 Key AI 归类功能，
  只有使用者自己填了 Key 并打开开关才会联网。
