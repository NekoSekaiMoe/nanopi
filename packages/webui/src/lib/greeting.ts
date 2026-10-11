// Random one-line classical Chinese poems for the landing tagline (zh only;
// English keeps the i18n `chat.greeting`). One line per entry, source inline.

export const GREETINGS: readonly string[] = [
  "路漫漫其修远兮，吾将上下而求索。——屈原《离骚》",
  "欲穷千里目，更上一层楼。——王之涣《登鹳雀楼》",
  "长风破浪会有时，直挂云帆济沧海。——李白《行路难》",
  "会当凌绝顶，一览众山小。——杜甫《望岳》",
  "千淘万漉虽辛苦，吹尽狂沙始到金。——刘禹锡《浪淘沙》",
  "纸上得来终觉浅，绝知此事要躬行。——陆游《冬夜读书示子聿》",
  "问渠那得清如许？为有源头活水来。——朱熹《观书有感》",
  "山重水复疑无路，柳暗花明又一村。——陆游《游山西村》",
  "不畏浮云遮望眼，自缘身在最高层。——王安石《登飞来峰》",
  "沉舟侧畔千帆过，病树前头万木春。——刘禹锡《酬乐天扬州初逢席上见赠》",
  "博观而约取，厚积而薄发。——苏轼《稼说送张琥》",
  "操千曲而后晓声，观千剑而后识器。——刘勰《文心雕龙》",
];

export function randomGreeting(): string {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)]!;
}
