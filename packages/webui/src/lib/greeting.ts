// Random classical Chinese poems for the landing tagline (zh only; English
// keeps the i18n greeting). One poem per entry, source inline.

export interface Poem {
	/** The quoted line(s), punctuation included, no source suffix. */
	text: string;
	/** Attribution in 《书名》作者 form, without the leading ——. */
	source: string;
}

export const POEMS: readonly Poem[] = [
	{ text: "路漫漫其修远兮，吾将上下而求索。", source: "屈原《离骚》" },
	{ text: "欲穷千里目，更上一层楼。", source: "王之涣《登鹳雀楼》" },
	{ text: "长风破浪会有时，直挂云帆济沧海。", source: "李白《行路难》" },
	{ text: "会当凌绝顶，一览众山小。", source: "杜甫《望岳》" },
	{ text: "千淘万漉虽辛苦，吹尽狂沙始到金。", source: "刘禹锡《浪淘沙》" },
	{ text: "纸上得来终觉浅，绝知此事要躬行。", source: "陆游《冬夜读书示子聿》" },
	{ text: "问渠那得清如许？为有源头活水来。", source: "朱熹《观书有感》" },
	{ text: "山重水复疑无路，柳暗花明又一村。", source: "陆游《游山西村》" },
	{ text: "不畏浮云遮望眼，自缘身在最高层。", source: "王安石《登飞来峰》" },
	{ text: "沉舟侧畔千帆过，病树前头万木春。", source: "刘禹锡《酬乐天扬州初逢席上见赠》" },
	{ text: "博观而约取，厚积而薄发。", source: "苏轼《稼说送张琥》" },
	{ text: "操千曲而后晓声，观千剑而后识器。", source: "刘勰《文心雕龙》" },
	{ text: "海内存知己，天涯若比邻。", source: "王勃《送杜少府之任蜀州》" },
	{ text: "落霞与孤鹜齐飞，秋水共长天一色。", source: "王勃《滕王阁序》" },
	{ text: "星垂平野阔，月涌大江流。", source: "杜甫《旅夜书怀》" },
	{ text: "大漠孤烟直，长河落日圆。", source: "王维《使至塞上》" },
	{ text: "明月松间照，清泉石上流。", source: "王维《山居秋暝》" },
	{ text: "海上生明月，天涯共此时。", source: "张九龄《望月怀远》" },
	{ text: "春江潮水连海平，海上明月共潮生。", source: "张若虚《春江花月夜》" },
	{ text: "天行健，君子以自强不息。", source: "《周易》" },
	{ text: "非淡泊无以明志，非宁静无以致远。", source: "诸葛亮《诫子书》" },
	{ text: "宝剑锋从磨砺出，梅花香自苦寒来。", source: "《警世贤文》" },
	{ text: "九万里风鹏正举。", source: "李清照《渔家傲》" },
	{ text: "莫听穿林打叶声，何妨吟啸且徐行。", source: "苏轼《定风波》" },
	{ text: "回首向来萧瑟处，归去，也无风雨也无晴。", source: "苏轼《定风波》" },
	{ text: "众里寻他千百度，蓦然回首，那人却在灯火阑珊处。", source: "辛弃疾《青玉案·元夕》" },
	{ text: "稻花香里说丰年，听取蛙声一片。", source: "辛弃疾《西江月·夜行黄沙道中》" },
	{ text: "沾衣欲湿杏花雨，吹面不寒杨柳风。", source: "志南《绝句》" },
];

export function randomPoem(): Poem {
	return POEMS[Math.floor(Math.random() * POEMS.length)]!;
}
