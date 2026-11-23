import { Person } from '../people/model.js';
import { WorkItem } from '../workItems/model.js';
import { MediaItem } from '../media/model.js';
import { Submission } from '../submissions/model.js';
import { ChatMessage } from '../chat/chatMessage.model.js';
import { ChannelMember } from '../chat/channelMember.model.js';
import { canSeeStepOutput, notFound, requireParticipant } from '../workItems/access.js';
import { visibleVersionsFilter } from '../workItems/viewerRules.js';
import { hasPermission, isOwnScope } from '../../lib/roleAccess.js';
import { fileRefFilter } from '../../lib/storage/keys.js';

/**
 * May this user open this stored file? Used before a fresh signed URL is handed out again
 * (POST /api/files/refresh). The file is allowed when a record that holds it is one the user
 * may see under the existing rules:
 *   - a profile photo: any signed-in user (photos show beside names everywhere);
 *   - a chat attachment or share card: a member of the channel with chat access; a revoked share
 *     card or a deleted message does not count;
 *   - a clip, a submitted version's file or a step's deliverable: anyone who sees all work; a
 *     worker only as a participant who may see that step's output (Phase 3 rules), so another
 *     person's file is "not found".
 * Anything else answers the same 404 as a missing file.
 */
export async function assertCanReadFile(user, key) {
  // Matches the key and an older "/uploads/..." value (setters would rewrite a plain filter).
  const ref = fileRefFilter(key);
  const userId = String(user?._id || user?.id || user?.userId || '');

  // Only photo-shaped keys count as photos, so no other file can be shared by naming it as a photo.
  const isPhoto = key.startsWith('uploads/avatars/') || /^uploads\/avatar-[^/]+$/.test(key);
  if (isPhoto && (await Person.exists({ avatarUrl: ref }))) return;

  const canChat = hasPermission(user, 'chat.use') || hasPermission(user, 'chat.read');
  if (canChat) {
    const messages = await ChatMessage.find({
      isDeleted: { $ne: true },
      $or: [
        { 'attachments.storageUrl': ref },
        { 'sharedMedia.isRevoked': { $ne: true }, $or: [{ 'sharedMedia.previewUrl': ref }, { 'sharedMedia.downloadUrl': ref }, { 'sharedMedia.thumbnailUrl': ref }] },
      ],
    }).select('channelId').limit(20).lean();
    for (const m of messages) if (await ChannelMember.exists({ channelId: m.channelId, userId })) return;
  }

  const seesAll = !isOwnScope(user);
  const stepAllowed = async (stepId, { versionId } = {}) => {
    if (!stepId) return false;
    if (seesAll) return Boolean(await WorkItem.exists({ _id: stepId }));
    try {
      const { workItem, participation } = await requireParticipant(String(stepId), user);
      if (versionId) {
        const allowed = await visibleVersionsFilter(workItem, user);
        return !allowed || allowed.includes(String(versionId));
      }
      return canSeeStepOutput(workItem, participation);
    } catch {
      return false;
    }
  };

  for (const clip of await MediaItem.find({ $or: [{ url: ref }, { thumbnailUrl: ref }] }).select('stageItemId').limit(20).lean()) {
    if (await stepAllowed(clip.stageItemId)) return;
  }
  for (const sub of await Submission.find({ $or: [{ 'files.url': ref }, { fileUrl: ref }, { linkUrl: ref }] }).select('workItemId').limit(20).lean()) {
    if (await stepAllowed(sub.workItemId, { versionId: sub._id })) return;
  }
  for (const step of await WorkItem.find({ deliverableUrl: ref }).select('_id').limit(20).lean()) {
    if (await stepAllowed(step._id)) return;
  }
  throw notFound();
}
