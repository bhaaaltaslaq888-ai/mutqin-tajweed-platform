/* ============================================================================
   منصّة مُتقِن — طبقة الربط بـ Supabase   (المراحل 5 · 6 · 7)
   يُدمج مع Mutqin_Platform_v17.html
   ----------------------------------------------------------------------------
   الإعداد:
   1) أضف قبل </head> في ملف المنصّة:
        <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
        <script src="mutqin_supabase.js"></script>
   2) املأ SUPABASE_URL و SUPABASE_ANON_KEY أدناه من:
        Supabase Dashboard ← Project Settings ← API
   ============================================================================ */

const SUPABASE_URL      = 'https://nzfngfbqnahypqgfhgee.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7Nl8-mywt9Nq4pCx62y3Ew_0qabpKLV';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* الحالة العامّة */
const MQ = {
  user: null,        // auth user
  profile: null,     // { id, full_name, role, teacher_id }
  get role(){ return MQ.profile?.role || null; },
};


/* ════════════════════════════════════════════════════════════════════
   ٥) المصادقة والأدوار
   ════════════════════════════════════════════════════════════════════ */

async function mqSignUp(email, password, fullName){
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { full_name: fullName } }
  });
  if (error) throw error;
  return data;
}

async function mqSignIn(email, password){
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  await mqLoadProfile();
  return data;
}

async function mqSignOut(){
  await sb.auth.signOut();
  MQ.user = null; MQ.profile = null;
}

async function mqLoadProfile(){
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { MQ.user = null; MQ.profile = null; return null; }
  MQ.user = user;
  const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (error) throw error;
  MQ.profile = data;
  return data;
}

/* استعادة الجلسة عند فتح الصفحة */
async function mqInit(){
  const { data: { session } } = await sb.auth.getSession();
  if (session) { await mqLoadProfile(); }
  return MQ.profile;
}


/* ════════════════════════════════════════════════════════════════════
   إدارة المستخدمين  (للإدارة فقط — تنجح فقط إذا كان الدور admin بفضل RLS)
   ════════════════════════════════════════════════════════════════════ */

// قائمة كل المعلّمين
async function mqListTeachers(){
  const { data, error } = await sb.from('profiles')
    .select('id, full_name, email').eq('role','teacher').order('full_name');
  if (error) throw error;
  return data;
}

// قائمة طلاب معلّم معيّن
async function mqListStudentsOf(teacherId){
  const { data, error } = await sb.from('profiles')
    .select('id, full_name, email').eq('teacher_id', teacherId).order('full_name');
  if (error) throw error;
  return data;
}

// ترقية/تعيين دور (admin فقط)
async function mqSetRole(userId, role){
  const { error } = await sb.from('profiles').update({ role }).eq('id', userId);
  if (error) throw error;
}

// ربط طالب بمعلّم (admin فقط)
async function mqAssignTeacher(studentId, teacherId){
  const { error } = await sb.from('profiles').update({ teacher_id: teacherId }).eq('id', studentId);
  if (error) throw error;
}


/* ════════════════════════════════════════════════════════════════════
   ٦) التتبّع المركزي  +  التحديث التلقائي
   ════════════════════════════════════════════════════════════════════ */

// حفظ تقدّم الطالب (يستبدل localStorage)
async function mqSaveProgress(courseId, ruleId, { done=true, examScore=null, stars=0 } = {}){
  if (!MQ.user) return;
  const row = {
    student_id: MQ.user.id, course_id: courseId,
    rule_id: ruleId || '',          // '' لدرجة اختبار الدورة (لا null — يحفظ القيد الفريد)
    done, exam_score: examScore, stars, updated_at: new Date().toISOString()
  };
  const { error } = await sb.from('progress')
    .upsert(row, { onConflict: 'student_id,course_id,rule_id' });
  if (error) console.error('saveProgress', error);
}

// جلب تقدّم الطالب الحالي
async function mqMyProgress(){
  const { data, error } = await sb.from('progress')
    .select('*').eq('student_id', MQ.user.id);
  if (error) throw error;
  return data;
}

// لوحة المعلّم: تقدّم كل طلابه (RLS يقصره على طلابه)
async function mqTeacherDashboard(){
  const students = await mqListStudentsOf(MQ.user.id);
  const ids = students.map(s => s.id);
  if (!ids.length) return [];
  const { data: prog } = await sb.from('progress').select('*').in('student_id', ids);
  return students.map(s => ({
    ...s,
    progress: (prog||[]).filter(p => p.student_id === s.id),
    completed: (prog||[]).filter(p => p.student_id===s.id && p.done).length,
  }));
}

// لوحة الإدارة: ملخّص كل المستخدمين (RLS يسمح للإدارة فقط)
async function mqAdminOverview(){
  const { data: profiles } = await sb.from('profiles').select('*');
  const { data: prog } = await sb.from('progress').select('student_id, done');
  const byStudent = {};
  (prog||[]).forEach(p => { if(p.done){ byStudent[p.student_id]=(byStudent[p.student_id]||0)+1; } });
  return (profiles||[]).map(p => ({ ...p, completed: byStudent[p.id]||0 }));
}

// ── التحديث التلقائي: المحتوى المركزي ──
async function mqFetchActiveContent(){
  const { data, error } = await sb.from('content')
    .select('version, payload, published_at').eq('is_active', true)
    .order('published_at', { ascending:false }).limit(1).single();
  if (error) return null;          // لا يوجد محتوى منشور بعد
  return data;
}

// نشر نسخة محتوى جديدة (admin) — تصل للجميع فورًا عند فتحهم
async function mqPublishContent(version, payloadObj, notes=''){
  // عطّل النسخ السابقة
  await sb.from('content').update({ is_active:false }).eq('is_active', true);
  const { error } = await sb.from('content').insert({
    version, payload: payloadObj, notes, is_active: true, published_by: MQ.user.id
  });
  if (error) throw error;
}


/* ════════════════════════════════════════════════════════════════════
   ٧) الرسائل + المسج الصوتي
   ════════════════════════════════════════════════════════════════════ */

// المحادثة بين المستخدم الحالي وطرف آخر
async function mqConversation(otherId){
  const me = MQ.user.id;
  const { data, error } = await sb.from('messages')
    .select('*')
    .or(`and(sender_id.eq.${me},receiver_id.eq.${otherId}),and(sender_id.eq.${otherId},receiver_id.eq.${me})`)
    .order('created_at');
  if (error) throw error;
  return data;
}

// إرسال رسالة نصّية  (RLS يضمن طالب↔معلّمه فقط)
async function mqSendText(receiverId, body){
  const { error } = await sb.from('messages')
    .insert({ sender_id: MQ.user.id, receiver_id: receiverId, body });
  if (error) throw error;
}

// ── تسجيل صوتي عبر MediaRecorder ──
let _mqRec = null, _mqChunks = [];

async function mqStartRecording(){
  const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
  _mqChunks = [];
  _mqRec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  _mqRec.ondataavailable = e => { if (e.data.size) _mqChunks.push(e.data); };
  _mqRec.start();
}

function mqStopRecording(){
  return new Promise(resolve => {
    if (!_mqRec) return resolve(null);
    _mqRec.onstop = () => {
      const blob = new Blob(_mqChunks, { type:'audio/webm' });
      _mqRec.stream.getTracks().forEach(t => t.stop());
      _mqRec = null;
      resolve(blob);
    };
    _mqRec.stop();
  });
}

// رفع المسج الصوتي وإرساله
async function mqSendVoice(receiverId, blob, seconds){
  const path = `${MQ.user.id}/${crypto.randomUUID()}.webm`;
  const { error: upErr } = await sb.storage.from('voice-messages')
    .upload(path, blob, { contentType:'audio/webm' });
  if (upErr) throw upErr;
  const { error } = await sb.from('messages').insert({
    sender_id: MQ.user.id, receiver_id: receiverId,
    audio_url: path, audio_seconds: seconds
  });
  if (error) throw error;
}

// رابط موقّت لتشغيل الصوت (ينتهي خلال ساعة) — لحماية الخصوصية
async function mqVoiceUrl(path){
  const { data, error } = await sb.storage.from('voice-messages')
    .createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

// تعليم الرسائل مقروءة
async function mqMarkRead(messageIds){
  if (!messageIds.length) return;
  await sb.from('messages').update({ is_read:true }).in('id', messageIds);
}

// ── الزمن الحقيقي: استقبال الرسائل فور وصولها ──
function mqSubscribeMessages(onMessage){
  const me = MQ.user.id;
  return sb.channel('messages-rt')
    .on('postgres_changes',
      { event:'INSERT', schema:'public', table:'messages', filter:`receiver_id=eq.${me}` },
      payload => onMessage(payload.new))
    .subscribe();
}

// عدد الرسائل غير المقروءة
async function mqUnreadCount(){
  const { count } = await sb.from('messages')
    .select('id', { count:'exact', head:true })
    .eq('receiver_id', MQ.user.id).eq('is_read', false);
  return count || 0;
}


/* ════════════════════════════════════════════════════════════════════
   جسر التوافق مع v17:
   استبدل استدعاءات save()/load() القديمة بهذه عند تفعيل الخادم
   ════════════════════════════════════════════════════════════════════ */

// مزامنة تقدّم localStorage القديم إلى الخادم (هجرة لمرّة واحدة)
async function mqMigrateLocalProgress(localS){
  if (!MQ.user || !localS) return;
  const rows = [];
  ['c1','c2','c3'].forEach(cid => {
    (localS.done?.[cid]||[]).forEach(ri => {
      rows.push({ student_id:MQ.user.id, course_id:cid, rule_id:'r'+(ri+1), done:true });
    });
    if (localS.exam?.[cid] != null){
      rows.push({ student_id:MQ.user.id, course_id:cid, rule_id:'',
                  done:localS.passed?.[cid]||false, exam_score:localS.exam[cid] });
    }
  });
  if (rows.length){
    await sb.from('progress').upsert(rows, { onConflict:'student_id,course_id,rule_id' });
  }
}

window.MQ = MQ;   // للوصول من الكونسول أثناء التطوير
